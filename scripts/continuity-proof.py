#!/usr/bin/env python3
"""Native installed Pi 1.4.0 RPC continuity proof; explicit source loading only.

Live (uses your Claude Haiku subscription; never runs on import/help):
  python3 continuity-proof.py --source-extension-dir /checkout/integrations/pi-claude-cli \
    --output-dir /tmp/continuity-proof-candidate --live
Baseline: use the same command with the baseline source directory, fresh output.
Stub: replace --live with --stub (embedded fail-closed fixture), optionally
  --transient-retry to prove native parked retry. Or use --stub-cli /path/to/fixture.
The basic e2e stub is not a continuity fixture. A compatible fixture
must support these synthetic prompts, continuity_tool's plain/abort/steer modes,
native MCP handoffs, Haiku model metadata, and persistent user UUID acknowledgments.
Stub runs use a disposable HOME and cannot qualify subscription/model behavior.

No deadlines, sleeps, polling, automatic replay or harness retries. A tool-running
notification drives RPC abort or /continuity-steer; the latter uses Pi's native
sendUserMessage(deliverAs='steer') BEFORE releasing the tool. Ctrl-C/SIGTERM stops
only this run's owned process tree. Unknown external outcomes are never replayed.
All proof inputs are synthetic. No credentials are read/copied/logged; live HOME
and the adapter's existing private subscription profile remain in place.
"""
import argparse
import asyncio
import base64
import random
import struct
import zlib
import hashlib
import json
import subprocess
from datetime import datetime
import os
from pathlib import Path
import shutil
import signal
import sys
import time

MODEL = "claude-haiku-5-5"  # Model used for the live proof.
PROVIDER = "pi-claude-cli"


def _source_package_name(source: Path) -> str | None:
    """This tree's own package.json name; None when unreadable."""
    try:
        name = json.loads((source / "package.json").read_text()).get("name")
    except (OSError, ValueError, AttributeError):
        return None
    return name if isinstance(name, str) and name else None


def package_state_leaf(source: Path) -> str:
    """On-disk leaf for Pi agent state and state-home diagnostics."""
    return "pi-claude-tether" if _source_package_name(source) == "pi-claude-tether" else "pi-claude-cli"


def package_data_dir(source: Path, home: Path) -> Path:
    """Package-derived data dir (mirrors src/data-dir.ts, no export edit)."""
    if _source_package_name(source) == "pi-claude-tether":
        base = Path(os.environ.get("XDG_DATA_HOME") or (home / ".local/share"))
        return base / "pi-claude-tether"
    return home / ".local/share/pi-claude-cli"
# Bundled updater policy only when this installation has no owned SDK.
# Exact tested version for this installed-engine proof; not a compatibility range.
SUPPORTED_INSTALLED_PI_VERSION = "1.4.0"
SYSTEM = ("This is a synthetic continuity proof. Call continuity_tool exactly once when asked, "
          "using precisely the requested mode. Use no other tools. After its result, reply only "
          "with the requested marker. Obey newer user steering over older instructions. "
          "Do not repeat an aborted tool. Do no unrelated work.")

# Observation preload; the explicit seed flag alone rewrites one synthetic receipt.
# It never changes argv, stdin, original CLI state or adapter source.
# Metadata projection deliberately omits credentials, MCP secrets, full init, and content bodies.
OBSERVER = r'''const cp = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
if (!process.env.CONTINUITY_OBSERVER_OWNER_PID) {
  process.env.CONTINUITY_OBSERVER_OWNER_PID = String(process.pid);
  const fd = Number(process.env.CONTINUITY_OBSERVER_FD);
  let seq = 0;
  const emit = row => {
    const line = JSON.stringify({ at: new Date().toISOString(), monoNs: process.hrtime.bigint().toString(), seq: ++seq, ...row })+'\n';
    fs.appendFileSync(process.env.CONTINUITY_CLI_LOG, line, {mode:0o600});
    fs.writeSync(fd, line);
  };
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const meta = m => ({
    frameType: m.type, subtype: m.subtype, uuid: m.uuid,
    sessionId: m.session_id, parentToolUseId: m.parent_tool_use_id,
    userMessageUuid: m.user_message_uuid, userMessageUuids: m.user_message_uuids,
    messageId: m.message?.id, model: m.message?.model,
    usage: m.message?.usage, stopReason: m.message?.stop_reason,
    requestId: m.request_id ?? m.response?.request_id,
    controlSubtype: m.request?.subtype ?? m.response?.subtype,
    contentKinds: Array.isArray(m.message?.content) ? m.message.content.map(b => b.type) : undefined,
    // Only the synthetic fixture tool is exposed: retain its actual result echo
    // so a lost/rewritten body can be inspected independently of marker answers.
    toolResults: Array.isArray(m.message?.content) ? m.message.content.filter(b => b?.type === 'tool_result') : undefined,
    messageSha256: m.message ? sha(JSON.stringify(m.message)) : undefined,
    contentSha256: m.message?.content !== undefined ? sha(JSON.stringify(m.message.content)) : undefined,
  });
  const lines = (onLine) => {
    const decoder = new StringDecoder('utf8'); let buf = '';
    return chunk => {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0,i); buf = buf.slice(i+1);
        let m; try { m = JSON.parse(line); } catch {
          emit({type:'unparsed_cli_line',bytes:Buffer.byteLength(line),sha256:sha(line)}); continue;
        }
        onLine(m, line);
      }
    };
  };
  let subscriptionVerified = false;
  const original = cp.spawn;
  cp.spawn = function(command, args = [], options) {
    const isCli = command === 'claude' || /[/\\]claude(?:\.exe|\.cmd)?$/.test(String(command));
    if (!isCli) return original.apply(this, arguments);
    const model = args.includes('--model') ? args[args.indexOf('--model')+1] : undefined;
    const env = options?.env ?? process.env;
    if (model) {
      if (model !== 'claude-haiku-5-5') throw new Error('Continuity exact-model guard refused '+model);
      for (const key of Object.keys(env)) {
        if (env[key] && (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)$/.test(key) ||
            /^(ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/.test(key)))
          throw new Error('Continuity credential-route guard refused '+key);
      }
      if (process.env.CONTINUITY_TRANSPORT === 'live' && !subscriptionVerified)
        throw new Error('Continuity subscription metadata has not been verified');
    }
    const child = original.apply(this, arguments);
    emit({type:'cli_spawn',pid:child.pid,piPid:process.pid,command,argv:args,model,probe:!model,
      configDir:env.CLAUDE_CONFIG_DIR,transport:process.env.CONTINUITY_TRANSPORT});
    const activeMessages = new Map();
    const authProbe = args[0] === 'auth' && args[1] === 'status';
    const versionProbe = args.includes('--version');
    let authBody = '', versionBody = '';
    const observeFrame = m => {
      if (m.loggedIn !== undefined) {
        subscriptionVerified = m.loggedIn === true && m.authMethod === 'claude.ai' &&
          typeof m.subscriptionType === 'string' && m.subscriptionType.length > 0;
        emit({type:'auth_status',pid:child.pid,loggedIn:m.loggedIn,authMethod:m.authMethod,
          subscriptionType:m.subscriptionType,subscriptionVerified});
      }
      if (m.type === 'system' && m.subtype === 'init') {
        emit({type:'cli_init',pid:child.pid,model:m.model,sessionId:m.session_id,apiKeySource:m.apiKeySource});
        if (process.env.CONTINUITY_TRANSPORT === 'live' && m.apiKeySource !== 'none')
          throw new Error('Continuity init did not explicitly prove apiKeySource=none');
        if (process.env.CONTINUITY_TRANSPORT === 'live' && m.model !== 'claude-haiku-5-5')
          throw new Error('Continuity physical init model differs from authorization');
      }
      const row = {type:'cli_stdout_metadata',pid:child.pid,...meta(m)};
      if (m.type === 'stream_event') {
        const e = m.event ?? {}; row.eventType = e.type;
        if (e.type === 'message_start') {
          activeMessages.set(m.parent_tool_use_id ?? null, e.message?.id);
          Object.assign(row, {messageId:e.message?.id,model:e.message?.model,usage:e.message?.usage});
        } else Object.assign(row, {messageId:activeMessages.get(m.parent_tool_use_id ?? null),usage:e.usage,stopReason:e.delta?.stop_reason});
        if (e.type === 'content_block_start') Object.assign(row, {
          contentKind:e.content_block?.type,toolName:e.content_block?.name,toolUseId:e.content_block?.id});
      }
      if (m.type === 'result') Object.assign(row, {
        usage:m.usage,modelUsage:m.modelUsage,isError:m.is_error,totalCostUsd:m.total_cost_usd});
      emit(row);
      if (process.env.CONTINUITY_TRANSPORT === 'live' && row.model && row.model !== 'claude-haiku-5-5')
        throw new Error('Continuity physical response model differs from authorization');
    };
    // auth status is a whole pretty-printed JSON document, not stream NDJSON.
    // Keep it only in memory; project the allowed metadata after close.
    if (process.env.CONTINUITY_RECEIPT_SEED && model && child.stdout) {
      const originalEmit = child.stdout.emit;
      const rewrite = lines((m, raw) => {
        const receipts = !m.parent_tool_use_id && m.type === 'user' && Array.isArray(m.message?.content)
          ? m.message.content.filter(b => b.type === 'tool_result') : [];
        if (receipts.length) {
          let seeded = false;
          try { fs.writeFileSync(process.env.CONTINUITY_RECEIPT_SEED, 'seeded\n', {flag:'wx',mode:0o600}); seeded = true; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          if (seeded) {
            const receipt = receipts[0];
            const expectedSha256 = sha(JSON.stringify(receipt.content));
            receipt.content = process.env.CONTINUITY_RECEIPT_SHAPE === 'long-error' && typeof receipt.content === 'string'
              ? '!' + receipt.content.slice(1) : [{type:'text',text:'SEEDED-RECEIPT-BODY-LOSS'}];
            raw = JSON.stringify(m);
            emit({type:'seeded_receipt_mismatch',pid:child.pid,toolUseId:receipt.tool_use_id,
              expectedSha256,observedSha256:sha(JSON.stringify(receipt.content))});
          }
        }
        originalEmit.call(child.stdout, 'data', Buffer.from(raw+'\n'));
      });
      child.stdout.emit = function(event, ...args) {
        if (event === 'data') { rewrite(args[0]); return true; }
        return originalEmit.call(this,event,...args);
      };
    }
    child.stdout?.on('data', authProbe ? chunk => { authBody += chunk.toString(); } :
      versionProbe ? chunk => { versionBody += chunk.toString(); } : lines(observeFrame));
    if (child.stdin) {
      const observe = lines(m => emit({type:'cli_stdin_metadata',pid:child.pid,...meta(m)}));
      const write = child.stdin.write;
      child.stdin.write = function(chunk, ...rest) { observe(chunk); return write.call(this,chunk,...rest); };
    }
    child.once('error', error => emit({type:'cli_error',pid:child.pid,code:error.code}));
    child.once('exit', (code,signal) => emit({type:'cli_exit',pid:child.pid,code,signal}));
    child.once('close', (code,signal) => {
      if (versionProbe) {
        const version = versionBody.trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
        emit({type:'cli_version',pid:child.pid,version,code});
        if (process.env.CONTINUITY_EXPECTED_CLI_VERSION &&
            (code !== 0 || version !== process.env.CONTINUITY_EXPECTED_CLI_VERSION))
          throw new Error('Continuity physical CLI version differs from qualification target');
        versionBody = '';
      }
      if (authProbe) {
        try { observeFrame(JSON.parse(authBody)); }
        catch { emit({type:'auth_status',pid:child.pid,subscriptionVerified:false,parseError:true,
          bytes:Buffer.byteLength(authBody),sha256:sha(authBody)}); }
        authBody = '';
      }
      emit({type:'cli_close',pid:child.pid,code,signal});
    });
    return child;
  };
}
'''


# Deterministic local CLI protocol fixture, materialized ONLY in the owned output.
# Real native Pi and adapter execute the tool and broker. No sleeps/model calls.
STUB = r'''#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const emit = row => process.stdout.write(JSON.stringify(row)+'\n');
if (args.includes('--version')) { console.log(process.env.CONTINUITY_STUB_VERSION || '2.1.283 (continuity local fixture)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  fs.writeSync(1, JSON.stringify({loggedIn:true,authMethod:'stub',subscriptionType:'stub'}, null, 2)+'\n'); process.exit(0);
}
const model = args[args.indexOf('--model')+1];
if (model !== 'claude-haiku-5-5') throw new Error('Stub exact-model selection changed');
const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1], 'utf8'));
const [, , socketPath, session, secretPath] = config.mcpServers['custom-tools'].args;
if (!socketPath || !secretPath) throw new Error('Stub requires the native custom-tool handoff broker');
const trace = row => fs.appendFileSync(process.env.CONTINUITY_STUB_LOG,
  JSON.stringify({monoNs:process.hrtime.bigint().toString(),pid:process.pid,...row})+'\n');
trace({type:'spawn',session,configDir:process.env.CLAUDE_CONFIG_DIR || null});
emit({type:'system',subtype:'init',session_id:session,model,apiKeySource:'none'});
// Overage proof: account B answers, the default profile rejects with the real
// weekly-limit text after a rejected window, emitting nothing else.
const failover = process.env.CONTINUITY_FAILOVER === '1';
const failoverB = (process.env.CLAUDE_CONFIG_DIR || '').includes('/accounts/b/');
// Usage-credit guard proof: bill this turn to overage, then answer normally.
const overage = process.env.CONTINUITY_OVERAGE === '1';
function overageBilled() {
  emit({type:'rate_limit_event', rate_limit_info:{status:'allowed_warning',
    resetsAt: Math.floor(Date.now()/1000)+6*3600, rateLimitType:'overage',
    utilization:1.01, isUsingOverage:true}});
}
function limitRejected() {
  emit({type:'rate_limit_event', rate_limit_info:{status:'rejected',
    resetsAt: Math.floor(Date.now()/1000)+6*3600, rateLimitType:'seven_day',
    utilization:1.01, isUsingOverage:false}});
  result("You've hit your weekly limit \u00b7 resets Jan 1, 12am (Europe/Paris)");
}
let turn, lastToolResult, seq = 0, retrySeen = false;
const usage = {input_tokens:5,output_tokens:3,cache_read_input_tokens:200,cache_creation_input_tokens:0};
const frame = event => emit({type:'stream_event',event,parent_tool_use_id:null,session_id:session});
function cycle(text, tool) {
  const id = 'msg-continuity-'+process.pid+'-'+(++seq);
  for (const [key,value] of Object.entries(usage)) turn.usage[key] = (turn.usage[key] ?? 0) + value;
  const content = tool ? [{type:'tool_use',id:tool.id,name:'mcp__custom-tools__continuity_tool',input:{mode:tool.mode}}] : [{type:'text',text}];
  frame({type:'message_start',message:{id,role:'assistant',model,usage:{...usage,output_tokens:0}}});
  frame({type:'content_block_start',index:0,content_block:tool ? {...content[0],input:{}} : {type:'text',text:''}});
  frame({type:'content_block_delta',index:0,delta:tool ? {type:'input_json_delta',partial_json:JSON.stringify({mode:tool.mode})} : {type:'text_delta',text}});
  frame({type:'content_block_stop',index:0});
  frame({type:'message_delta',delta:{stop_reason:tool ? 'tool_use' : 'end_turn'},usage:{output_tokens:3}});
  frame({type:'message_stop'});
  emit({type:'assistant',session_id:session,parent_tool_use_id:null,message:{id,role:'assistant',model,content,usage,stop_reason:tool ? 'tool_use' : 'end_turn'}});
}
function result(error, text) {
  emit({type:'result',subtype:error ? 'error_during_execution' : 'success',is_error:!!error,
    errors:error ? [error] : undefined,result:text,session_id:session,num_turns:1,
    user_message_uuids:turn?.uuid ? [turn.uuid] : [],usage:turn?.usage ?? {input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
  turn = undefined;
}
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.map(b => b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '').join('\n');
}
function user(msg) {
  const blocks = msg.message?.content;
  // A restarted baseline may replay the full Pi transcript. Interpret only its
  // newest USER section, not historical tool instructions; restart is measured
  // independently and must not be disguised as model confusion by this fixture.
  const userIndex = Array.isArray(blocks) ? blocks.findLastIndex(b => b.type === 'text' && b.text === 'USER:') : -1;
  const tail = userIndex < 0 ? blocks : blocks.slice(userIndex+1);
  const boundary = Array.isArray(tail) ? tail.findIndex(b => b.type === 'text' && (b.text === 'ASSISTANT:' || b.text.startsWith('TOOL RESULT ('))) : -1;
  const text = textOf(boundary < 0 ? tail : tail.slice(0,boundary));
  trace({type:'stdin_user',uuid:msg.uuid,contentKinds:Array.isArray(blocks)?blocks.map(b=>b.type):['string'],sha256:crypto.createHash('sha256').update(JSON.stringify(blocks)).digest('hex')});
  if (turn) throw new Error('User appended while prior tool turn is active: default priority=next is NOT independent steering');
  if (text.includes('STEER-OK') && Array.isArray(blocks) && blocks.some(b=>b.type==='tool_result'))
    throw new Error('Steering smuggled into a tool_result instead of an independent user');
  turn = {uuid:msg.uuid,usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},
    rejectAfter:failover && text.includes('FAILOVER-TOOL')};
  // --replay-user-messages is the real consumption acknowledgment boundary.
  emit({...msg,type:'user',session_id:session,parent_tool_use_id:null});
  const mode = text.match(/mode\s+["']?(plain|abort|steer)/)?.[1];
  if (mode) {
    const id = 'tool-continuity-'+process.pid+'-'+seq;
    turn.mode = mode; turn.id = id;
    cycle('', {id,mode});
    const socket = net.createConnection(socketPath);
    turn.socket = socket;
    socket.on('connect', () => socket.write(JSON.stringify({type:'call',session,toolUseId:id,name:'continuity_tool',arguments:{mode},secret:fs.readFileSync(secretPath,'utf8')})+'\n'));
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString();
      if (!buf.includes('\n')) return;
      const response = JSON.parse(buf.slice(0,buf.indexOf('\n')));
      trace({type:'tool_result',mode,toolUseId:id,isError:response.isError});
      if (!turn || turn.id !== id) return;
      turn.delivered = true;
      lastToolResult = textOf(response.content);
      // Verified CLI 2.1.283 representation: only single-text errors trim.
      let echo = response.isError && response.content?.length === 1 && response.content[0].type === 'text'
        ? response.content[0].text.trim() : response.content;
      // Official error codec (2.1.284/2.1.311): 10k retained, 1024 allowance.
      // This stub qualifies the receipt boundary, never live cache economics.
      if (response.isError && typeof echo === 'string' && echo.length > 11024)
        echo = echo.slice(0,5000) + `\n\n... [${echo.length-10000} characters truncated] ...\n\n` + echo.slice(-5000);
      emit({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,
        content:echo,is_error:!!response.isError}]},session_id:session,parent_tool_use_id:null});
      if (mode === 'plain') {
        if (turn.rejectAfter) { turn.rejectAfter = false; limitRejected(); }
        else { cycle('BASELINE-OK'); result(); }
      }
      // abort/steer remain active until native adapter interrupt; no guessed delay.
    });
    socket.on('error', error => trace({type:'socket_error',code:error.code}));
    return;
  }
  if (text.includes('CONTINUITY-RETRY')) {
    if (process.env.CONTINUITY_REFRESH_RETRY !== '1') {
      if (retrySeen) throw new Error('Transient retry resent the original failed user/prefix');
      retrySeen = true;
      result('Request timed out'); return;
    }
    const markerFile = process.env.CONTINUITY_STUB_LOG + '.refresh-seen';
    if (!fs.existsSync(markerFile)) {
      fs.writeFileSync(markerFile, 'failed before model');
      trace({type:'refresh_failure_before_model'});
      result('Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again'); return;
    }
    trace({type:'refresh_retry_received_user'});
    cycle('RETRY-OK'); result(); return;
  }
  if (failover && !failoverB && text.includes('FAILOVER')) { limitRejected(); return; }
  let marker;
  if (retrySeen && text.includes('Retry the failed request. Continue from the existing conversation')) marker='RETRY-OK';
  else if (text.includes('ABORT-OK')) marker='ABORT-OK';
  else if (text.includes('STEER-OK')) marker='STEER-OK';
  else if (text.includes('Recall the exact text returned')) {
    if (!lastToolResult) throw new Error('The real broker result was not retained before interrupt');
    marker=lastToolResult;
  }
  else if (text.includes('WARM-OK')) marker='WARM-OK';
  else if (text.includes('OVERAGE-OK')) {
    if (!overage) throw new Error('OVERAGE-OK without CONTINUITY_OVERAGE=1');
    overageBilled(); marker='OVERAGE-OK';
  }
  else if (text.includes('FAILOVER-OK')) marker='FAILOVER-OK';
  else if (text.includes('STILL-B')) marker='STILL-B';
  else throw new Error('Unexpected synthetic user request; no default-success stub path');
  cycle(marker); result();
}
let buf='';
process.stdin.on('data', chunk => {
  buf += chunk.toString(); let i;
  while ((i=buf.indexOf('\n'))>=0) {
    const line=buf.slice(0,i);buf=buf.slice(i+1);const msg=JSON.parse(line);
    if (msg.type==='control_request') {
      trace({type:'control',subtype:msg.request?.subtype});
      emit({type:'control_response',response:{subtype:'success',request_id:msg.request_id}});
      if (msg.request?.subtype==='interrupt' && turn) {
        const current=turn;
        trace({type:'interrupt',mode:current.mode,delivered:current.delivered});
        // Some obsolete provider paths interrupt before handoff delivery; keep the
        // observed aborted shape truthful, but do not silently accept steer misuse.
        current.socket?.destroy(); result('Interrupted');
      }
    } else if (msg.type==='user') user(msg);
    else trace({type:'other_stdin',frameType:msg.type});
  }
});
process.stdin.on('end',()=>process.exit(0));
'''


def stamp():
    return {"atNs": time.time_ns(), "monoNs": str(time.monotonic_ns())}


def resolve_owned_pi(pi_bin_arg, source, *, allow_missing=False):
    """Resolve the owned Pi engine through scripts/resolve-pi-cli.mjs.

    Public module resolution plus the SDK package's `bin` field; `<cli>
    --version` must equal the SDK manifest version. An explicit --pi-bin
    stays as an override only after the same `--version` check. There is
    no `which pi` fallback and no skip: missing/mismatched engines fail
    with the helper's named cause ([owned-pi-engine-unavailable] /
    [owned-pi-engine-version-mismatch]).
    """
    helper = Path(__file__).resolve().parent / "resolve-pi-cli.mjs"
    cmd = ["node", str(helper), "--package-dir", str(source), "--json"]
    if pi_bin_arg:
        cmd += ["--pi-bin", pi_bin_arg]
    # An installed-engine input is independent of an inherited PI_BIN override.
    env = dict(os.environ)
    if allow_missing:
        env.pop("PI_BIN", None)
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        if allow_missing and "no node_modules copy found" in detail:
            return None
        raise RuntimeError(detail or "Owned Pi engine resolution failed ([owned-pi-engine-unavailable])")
    owned = json.loads(proc.stdout)
    return Path(owned["cli"]), owned["version"]


def dump(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def lines(reader):
    # LF-only framing, including records longer than asyncio's default buffer.
    prefix = b""
    while True:
        try:
            row = await reader.readuntil(b"\n")
        except asyncio.LimitOverrunError as error:
            prefix += await reader.readexactly(error.consumed)
            continue
        except asyncio.IncompleteReadError as error:
            if prefix or error.partial:
                yield prefix + error.partial
            return
        yield prefix + row
        prefix = b""


class Rpc:
    def __init__(self, process, output):
        self.process, self.output = process, output
        self.rows, self.pending = [], {}
        self.changed = asyncio.Condition()
        self.eof = False
        self.failure = None
        self.phase = "startup"
        self.command_number = 0
        self.wire = (output / "rpc-events.jsonl").open("wb")
        self.commands = (output / "rpc-commands.jsonl").open("w")
        self.timeline = (output / "timeline.jsonl").open("w")

    async def publish(self, source, row):
        async with self.changed:
            event = {**stamp(), "phase": self.phase, "source": source, "record": row}
            self.rows.append(event)
            self.timeline.write(json.dumps(event) + "\n")
            self.timeline.flush()
            self.changed.notify_all()

    async def read(self):
        try:
            async for raw in lines(self.process.stdout):
                self.wire.write(raw)
                self.wire.flush()
                row = json.loads(raw)
                await self.publish("rpc", row)
                if row.get("type") == "response":
                    future = self.pending.pop(row.get("id"), None)
                    if future and not future.done():
                        future.set_result(row)
                if row.get("type") == "extension_error":
                    self.failure = RuntimeError(f"Native extension error: {row}")
        except BaseException as error:
            self.failure = error
        finally:
            async with self.changed:
                self.eof = True
                for future in self.pending.values():
                    if not future.done():
                        future.set_exception(RuntimeError("Pi RPC exited before response"))
                self.changed.notify_all()

    async def command(self, kind, **kwargs):
        self.command_number += 1
        row = {"id": f"continuity-{self.command_number}", "type": kind, **kwargs}
        future = asyncio.get_running_loop().create_future()
        self.pending[row["id"]] = future
        self.commands.write(json.dumps({**stamp(), "phase": self.phase, "command": row}) + "\n")
        self.commands.flush()
        await self.publish("command", row)
        self.process.stdin.write(json.dumps(row).encode() + b"\n")
        await self.process.stdin.drain()
        response = await future
        if not response.get("success"):
            raise RuntimeError(f"Native RPC command refused: {response}")
        return response.get("data") or {}

    async def wait(self, predicate, since=0, fail_on_settle=False):
        async with self.changed:
            cursor = since
            while True:
                for event in self.rows[cursor:]:
                    if predicate(event):
                        return event
                    if fail_on_settle and event["source"] == "rpc" and event["record"].get("type") == "agent_settled":
                        raise RuntimeError("Pi settled before the expected running-tool signal")
                cursor = len(self.rows)
                if self.failure:
                    raise self.failure
                if self.eof:
                    raise RuntimeError("Pi RPC closed before expected event")
                await self.changed.wait()

    async def fixture(self, kind, mode=None, since=0, fail_on_settle=False):
        def match(event):
            row = event["record"]
            if event["source"] != "rpc" or row.get("type") != "extension_ui_request" or row.get("method") != "notify":
                return False
            text = row.get("message", "")
            if not text.startswith("CONTINUITY:"):
                return False
            data = json.loads(text[len("CONTINUITY:"):])
            return data.get("type") == kind and (mode is None or data.get("mode") == mode)
        return await self.wait(match, since, fail_on_settle)

    async def settled(self, since):
        return await self.wait(lambda e: e["source"] == "rpc" and e["record"].get("type") == "agent_settled", since)

    def close(self):
        self.wire.close()
        self.commands.close()
        self.timeline.close()


def fixture_data(event):
    return json.loads(event["record"]["message"][len("CONTINUITY:"):])


def owned_cleanup(pi_pid, handles):
    """Linux pidfds prevent PID reuse; add only current descendants of our owned roots."""
    roots = set()
    for pid, fd in handles.items():
        try:
            signal.pidfd_send_signal(fd, 0)
            roots.add(pid)
        except ProcessLookupError:
            pass  # An exited pidfd must never authorize a subsequently reused numeric PID.
    parents = {}
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            pid = int(path.parent.name)
            fields = path.read_text().rsplit(") ", 1)[1].split()
            parents[pid] = int(fields[1])
        except (OSError, ValueError, IndexError):
            continue
    owned = set(roots)
    while True:
        extra = {pid for pid, parent in parents.items() if parent in owned} - owned
        if not extra:
            break
        owned.update(extra)
    killed = []
    for pid in owned:
        if pid not in handles:
            try:
                handles[pid] = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
        try:
            signal.pidfd_send_signal(handles[pid], signal.SIGKILL)
            killed.append(pid)
        except ProcessLookupError:
            pass
    return {"rootPiPid": pi_pid, "ownedPidsSignalled": killed, "signal": "SIGKILL"}


def usage4(usage, physical=False):
    names = {"input": "input_tokens", "output": "output_tokens", "cacheRead": "cache_read_input_tokens", "cacheWrite": "cache_creation_input_tokens"}
    return {key: usage.get(names[key] if physical else key) for key in names}


def analyze(output, scenarios, transport):
    events = [json.loads(line) for line in (output / "timeline.jsonl").read_text().splitlines()]
    cli = [json.loads(line) for line in (output / "cli-metadata.jsonl").read_text().splitlines()] if (output / "cli-metadata.jsonl").exists() else []
    requests = {}
    gaps = []
    active = {}
    results = []
    for row in cli:
        pid = row.get("pid")
        if row.get("type") != "cli_stdout_metadata":
            continue
        if row.get("frameType") == "result":
            results.append(row)  # Cumulative process/turn results: NEVER added to request rows.
            continue
        message_id = row.get("messageId")
        if row.get("eventType") == "message_start":
            if not message_id:
                gaps.append({"type": "physical_message_id_missing", "pid": pid, "seq": row["seq"]})
                message_id = f"unidentified-start-{row['seq']}"
            active[(pid, row.get("parentToolUseId"))] = message_id
        if not message_id and row.get("eventType") in ("message_delta", "message_stop"):
            message_id = active.get((pid, row.get("parentToolUseId")))
        if not message_id or not (row.get("eventType") in ("message_start", "message_delta", "message_stop") or row.get("frameType") == "assistant"):
            continue
        key = (pid, message_id)
        request = requests.setdefault(key, {"pid": pid, "messageId": message_id, "startMonoNs": row["monoNs"], "model": row.get("model"), "usage": {}, "evidenceSeqs": [], "complete": False, "parentToolUseId": row.get("parentToolUseId")})
        request["evidenceSeqs"].append(row["seq"])
        if row.get("model"):
            request["model"] = row["model"]
        # These are snapshots of ONE physical request, not additive deltas.
        if row.get("usage"):
            request["usage"].update(row["usage"])
        if row.get("eventType") == "message_stop" or row.get("frameType") == "assistant":
            request["complete"] = True
        request["endMonoNs"] = row["monoNs"]
        request["stopReason"] = row.get("stopReason") or request.get("stopReason")
    physical = []
    for request in requests.values():
        request["tokens"] = usage4(request["usage"], True)
        request["phase"] = next((s["name"] for s in scenarios if int(s["startMonoNs"]) <= int(request["startMonoNs"]) <= int(s.get("endMonoNs", sys.maxsize))), "outside-scenario")
        if any(value is None for value in request["tokens"].values()):
            gaps.append({"type": "physical_usage_field_missing", "pid": request["pid"], "messageId": request["messageId"], "tokens": request["tokens"]})
        if not request["complete"]:
            gaps.append({"type": "physical_request_incomplete", "pid": request["pid"], "messageId": request["messageId"]})
        physical.append(request)
    with (output / "physical-requests.jsonl").open("w") as handle:
        for row in physical:
            handle.write(json.dumps(row) + "\n")
    dump(output / "cli-result-envelopes-not-additive.json", results)
    starts = [r for r in cli if r.get("type") == "cli_spawn" and not r.get("probe")]
    pi_requests = []
    counters = dict(input=0, output=0, cacheRead=0, cacheWrite=0)
    with (output / "native-event-measurements.jsonl").open("w") as handle:
        for index, event in enumerate(events):
            row = event["record"]
            if event["source"] != "rpc":
                continue
            if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant":
                message = row["message"]
                tokens = usage4(message.get("usage", {}))
                pi_requests.append({"timelineIndex": index, "phase": event["phase"], "monoNs": event["monoNs"], "model": message.get("model"), "provider": message.get("provider"), "stopReason": message.get("stopReason"), "tokens": tokens})
                for name, value in tokens.items():
                    counters[name] += value or 0
            at = int(event["monoNs"])
            spawned = [r for r in starts if int(r["monoNs"]) <= at]
            # Physical totals here are FINAL request snapshots attributed by request start.
            # Explicitly retrospective: not a claim that these counters were known at that instant.
            physical_before = [r for r in physical if int(r["startMonoNs"]) <= at]
            handle.write(json.dumps({"timelineIndex": index, "phase": event["phase"], "eventType": row.get("type"), "monoNs": event["monoNs"], "starts": len(spawned), "restarts": max(0, len(spawned)-1), "piFinalMessageCounters": dict(counters), "physicalFinalRequestTokensRetrospective": {k: sum(r["tokens"].get(k) or 0 for r in physical_before) for k in counters}}) + "\n")
    with (output / "pi-message-usage.jsonl").open("w") as handle:
        for row in pi_requests:
            handle.write(json.dumps(row) + "\n")
    report = {"transport": transport, "subscriptionQualification": transport == "live", "physicalCoverageGaps": gaps,
              "accounting": "Pi: final assistant messages and RPC stats. Physical: one row per CLI PID/message ID; snapshot merge. Result/modelUsage envelopes are retained separately and NEVER summed into physical requests.", "scenarios": []}
    for scenario in scenarios:
        name = scenario["name"]
        a, b = int(scenario["startMonoNs"]), int(scenario.get("endMonoNs", time.monotonic_ns()))
        spawns = [r for r in starts if a <= int(r["monoNs"]) <= b]
        before = sum(int(r["monoNs"]) < a for r in starts)
        after = before + len(spawns)
        selected = [r for r in physical if r["phase"] == name]
        p_usage = [r for r in pi_requests if r["phase"] == name]
        report["scenarios"].append({**scenario, "cliStarts": len(spawns), "cliRestarts": max(0, after-1)-max(0, before-1), "cliSpawnPids": [r["pid"] for r in spawns], "physicalRequestPids": sorted({r["pid"] for r in selected}), "physicalRequests": len(selected), "physicalTokens": {k: sum(r["tokens"].get(k) or 0 for r in selected) for k in counters}, "piMessageTokens": {k: sum(r["tokens"].get(k) or 0 for r in p_usage) for k in counters}})
    report["totalCliStarts"] = len(starts)
    report["totalCliRestarts"] = max(0, len(starts)-1)
    report["physicalRequests"] = len(physical)
    report["physicalTokens"] = {k: sum(r["tokens"].get(k) or 0 for r in physical) for k in counters}
    report["piMessageTokens"] = counters
    dump(output / "measurements.json", report)
    return report


def accounting_failures(report):
    """Observed spend must agree at physical, Pi-message and native-stat surfaces."""
    failures = []
    keys = ("input", "output", "cacheRead", "cacheWrite")
    if report["physicalTokens"] != report["piMessageTokens"]:
        failures.append("Physical and Pi-message total token counters disagree")
    for scenario in report["scenarios"]:
        before = scenario.get("piStatsBefore", {}).get("tokens", {})
        after = scenario.get("piStatsAfter", {}).get("tokens", {})
        if any(before.get(k) is None or after.get(k) is None for k in keys):
            failures.append(f"Native Pi stats coverage incomplete: {scenario['name']}")
            continue
        delta = {k: after[k] - before[k] for k in keys}
        if not scenario["physicalTokens"] == scenario["piMessageTokens"] == delta:
            failures.append(f"Physical/Pi-message/native-stat token counters disagree: {scenario['name']}")
    return failures


def failover_qualification(output, measurements, manifest):
    """Structural proof for the multi-account failover scenarios.

    Markers and tool counts are asserted inline during the run; this checks
    what only the retained artifacts can show: which profile each CLI spawn
    used, which account the ledger rows name, and which exhaustion files exist.
    """
    failures = []
    cli_rows = [json.loads(line) for line in (output / "cli-metadata.jsonl").read_text().splitlines()]
    spawns = [r for r in cli_rows if r.get("type") == "cli_spawn" and not r.get("probe")]
    by_name = {s["name"]: s for s in measurements["scenarios"]}
    for name in ("failover-limit", "failover-stays", "failover-tool-rejection", "failover-still-b"):
        if name not in by_name:
            failures.append(f"Failover scenario missing from measurements: {name}")
    if failures:
        return failures

    def window_spawns(scenario):
        a, b = int(scenario["startMonoNs"]), int(scenario.get("endMonoNs", time.monotonic_ns()))
        return [r for r in spawns if a <= int(r["monoNs"]) <= b]

    # S1 fails over inside one turn: exactly one new spawn, under b's profile.
    s1, s1_spawns = by_name["failover-limit"], window_spawns(by_name["failover-limit"])
    if s1["cliStarts"] != 1 or len(s1_spawns) != 1:
        failures.append(f"failover-limit must add exactly one CLI spawn, observed {s1['cliStarts']}")
    elif "/accounts/b/" not in (s1_spawns[0].get("configDir") or ""):
        failures.append(f"failover-limit respawn ran under {s1_spawns[0].get('configDir')!r}, not account b")
    # Warm b serves the next turn, the tool-rejection replays nothing, and the
    # final turn spawns fresh on b because the default is still exhausted.
    for name, expected in (("failover-stays", 0), ("failover-tool-rejection", 0), ("failover-still-b", 1)):
        observed = by_name[name]["cliStarts"]
        if observed != expected:
            failures.append(f"{name} must add {expected} CLI spawns, observed {observed}")
    s4_spawns = window_spawns(by_name["failover-still-b"])
    if len(s4_spawns) == 1 and "/accounts/b/" not in (s4_spawns[0].get("configDir") or ""):
        failures.append(f"failover-still-b spawned under {s4_spawns[0].get('configDir')!r}, not account b")

    # Exhaustion: the default is pinned until its CLI-reported resetsAt; the
    # tool-rejection on b must not have marked anything.
    pcc_state = output / "pcc-state"
    default_pin = pcc_state / "account-exhausted-default.json"
    if not default_pin.is_file():
        failures.append("Default account exhaustion was not recorded")
    else:
        resets_at = json.loads(default_pin.read_text()).get("resetsAt")
        if not isinstance(resets_at, (int, float)) or resets_at <= s1["startWall"] + 3600:
            failures.append(f"Default resetsAt is not a future CLI-reported time: {resets_at!r}")
    if (pcc_state / "account-exhausted-b.json").exists():
        failures.append("Account b was marked exhausted by a post-tool rejection; it must not be")

    # Ledger: every row in a failover window names an account, never a path.
    ledger_path = output / "request-ledger.jsonl"
    if not ledger_path.is_file():
        failures.append("Request ledger was not retained")
        return failures
    ledger = [json.loads(line) for line in ledger_path.read_text().splitlines()]

    def window_accounts(scenario):
        a, b = scenario["startWall"], scenario["endWall"]
        rows = []
        for row in ledger:
            try:
                at = row.get("at", "").replace("Z", "+00:00")
                stamp = datetime.fromisoformat(at).timestamp()
            except ValueError:
                continue
            if a <= stamp <= b:
                rows.append(row)
        return rows

    for name in ("failover-limit", "failover-stays", "failover-tool-rejection", "failover-still-b"):
        rows = window_accounts(by_name[name])
        if not rows:
            failures.append(f"No ledger rows in {name}")
            continue
        accounts = {r.get("account") for r in rows}
        if name == "failover-limit":
            if accounts != {"default", "b"}:
                failures.append(f"failover-limit ledger must name both accounts, found {sorted(a for a in accounts if a)}")
        elif accounts != {"b"}:
            failures.append(f"{name} ledger must name only account b, found {sorted(a for a in accounts if a)}")
        if any("claude-config" in json.dumps(r) for r in rows):
            failures.append(f"{name} ledger leaks a config path; only the account name may travel")
    manifest["failoverSpawns"] = len(spawns)
    return failures


def overage_qualification(output, measurements, manifest):
    """Structural proof for the usage-credit guard scenarios.

    The marker (failed turn mentioning usage credits, or the answered
    marker when opted in) is asserted inline during the run; this checks
    what only the retained artifacts can show: the overage turn reuses the
    warm parked process (no new spawn) and single-profile ledger rows carry
    no account key and never a config path.
    """
    failures = []
    cli_rows = [json.loads(line) for line in (output / "cli-metadata.jsonl").read_text().splitlines()]
    spawns = [r for r in cli_rows if r.get("type") == "cli_spawn" and not r.get("probe")]
    by_name = {s["name"]: s for s in measurements["scenarios"]}
    if "overage-guard" not in by_name:
        return ["Overage scenario missing from measurements"]

    def window_spawns(scenario):
        a, b = int(scenario["startMonoNs"]), int(scenario.get("endMonoNs", time.monotonic_ns()))
        return [r for r in spawns if a <= int(r["monoNs"]) <= b]

    scenario = by_name["overage-guard"]
    if scenario["cliStarts"] != 0 or window_spawns(scenario):
        failures.append(f"overage-guard must reuse the warm parked process, observed {scenario['cliStarts']} new spawns")

    ledger_path = output / "request-ledger.jsonl"
    if not ledger_path.is_file():
        failures.append("Request ledger was not retained")
        return failures
    ledger = [json.loads(line) for line in ledger_path.read_text().splitlines()]
    rows = []
    for row in ledger:
        try:
            at = row.get("at", "").replace("Z", "+00:00")
            stamp = datetime.fromisoformat(at).timestamp()
        except ValueError:
            continue
        if scenario["startWall"] <= stamp <= scenario["endWall"]:
            rows.append(row)
    if not rows:
        failures.append("No ledger rows in overage-guard")
    for row in rows:
        if "account" in row:
            failures.append("overage-guard ledger names an account on a single-profile run; the key must be absent")
            break
    if any("claude-config" in json.dumps(r) for r in rows):
        failures.append("overage-guard ledger leaks a config path")
    manifest["overageSpawns"] = len(spawns)
    return failures


def image_metadata(block):
    """Hash decoded synthetic bytes and read PNG/JPEG headers independently."""
    source = block.get("source", {})
    data = base64.b64decode(block.get("data", source.get("data", "")), validate=True)
    declared = block.get("mimeType", source.get("media_type"))
    mime, width, height = None, None, None
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        mime = "image/png"
        width, height = struct.unpack(">II", data[16:24])
    elif data.startswith(b"\xff\xd8"):
        mime = "image/jpeg"
        i = 2
        while i < len(data) and data[i] == 0xff:
            while i < len(data) and data[i] == 0xff:
                i += 1
            if i >= len(data):
                break
            marker = data[i]
            i += 1
            if marker in (0xd9, 0xda, 0):
                break
            if marker == 1 or 0xd0 <= marker <= 0xd7:
                continue
            if i + 2 > len(data):
                break
            length = int.from_bytes(data[i:i + 2], "big")
            if length < 2 or i + length > len(data):
                break
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf) and length >= 8:
                height, width = struct.unpack(">HH", data[i + 3:i + 7])
                break
            i += length
    return {"declaredMimeType": declared, "headerMimeType": mime, "width": width, "height": height,
            "decodedBytes": len(data), "decodedSha256": hashlib.sha256(data).hexdigest()}


def receipt_qualification(output, shape, measurements, manifest):
    """Use real Pi result and physical CLI echo, not model markers as proof."""
    failures = []
    rpc = [json.loads(line) for line in (output / "rpc-events.jsonl").read_text().splitlines()]
    cli = [json.loads(line) for line in (output / "cli-metadata.jsonl").read_text().splitlines()]
    returned = [r for r in rpc if r.get("type") == "tool_execution_end" and
                r.get("toolName") == "continuity_tool" and r.get("result", {}).get("details", {}).get("mode") == "plain"]
    proof = {"shape": shape, "handoffs": []}
    if len(returned) != 1:
        failures.append("Receipt shape requires exactly one native plain tool result")
    for result in returned:
        echoes = [(r, t) for r in cli if r.get("type") == "cli_stdout_metadata" and r.get("frameType") == "user" and not r.get("parentToolUseId")
                  for t in r.get("toolResults") or [] if t.get("tool_use_id") == result["toolCallId"]]
        if len(echoes) != 1:
            failures.append("Receipt shape requires exactly one physical same-ID echo")
            continue
        row, echo = echoes[0]
        expected, observed = result["result"]["content"], echo["content"]
        handoff = {"toolUseId": result["toolCallId"], "pid": row["pid"], "echoSeq": row["seq"],
                   "expectedIsError": bool(result.get("isError")), "observedIsError": bool(echo.get("is_error"))}
        if handoff["expectedIsError"] != handoff["observedIsError"]:
            failures.append("Receipt shape lost error status")
        if shape == "image-derivative":
            kinds = [b.get("type") for b in observed] if isinstance(observed, list) else []
            handoff["observedKinds"] = kinds
            # Native Pi may resize first and append its coordinate annotation.
            # Compare every actual delivered block, not the pre-Pi fixture shape.
            expected_kinds = [b.get("type") for b in expected]
            exact_companions = kinds == expected_kinds and all(
                a.get("type") == "image" or a == b for a, b in zip(expected, observed))
            handoff["expectedKinds"] = expected_kinds
            if not exact_companions or kinds.count("image") != 1:
                failures.append("Physical image receipt lost block structure or exact companion text")
            else:
                a, b = image_metadata(expected[1]), image_metadata(observed[1])
                handoff.update(expectedImage=a, observedImage=b, companionTextExact=True)
                changed = a["decodedSha256"] != b["decodedSha256"]
                handoff["imageBytesChanged"] = changed
                if not changed:
                    failures.append("Physical image receipt did not exercise derivative normalization")
                if not b["width"] or not b["height"] or b["declaredMimeType"] != b["headerMimeType"]:
                    failures.append("Physical image receipt has no matching PNG/JPEG header")
                else:
                    consistent = (b["width"] <= a["width"] and b["height"] <= a["height"] and
                                  2 * abs(b["width"] * a["height"] - b["height"] * a["width"]) <= max(a["width"], a["height"]))
                    handoff["dimensionsDownscaleConsistent"] = consistent
                    if not consistent:
                        failures.append("Physical image receipt dimensions are not downscale-consistent")
        else:
            joined = "\n".join(b["text"] for b in expected).strip()
            exact = isinstance(observed, str) and observed == joined
            handoff.update(expectedBlockCount=len(expected), observedRepresentation="string" if isinstance(observed, str) else "blocks",
                           newlineJoinOuterTrimExact=exact,
                           expectedTextChars=sum(len(b["text"]) for b in expected), observedTextChars=len(observed),
                           expectedJoinedSha256=hashlib.sha256(joined.encode()).hexdigest(),
                           observedTextSha256=hashlib.sha256(observed.encode()).hexdigest() if isinstance(observed, str) else None)
            if not exact:
                failures.append("Physical multi-text error is not the exact newline join with outer trim")
        warm = [r for r in measurements["scenarios"] if r["name"] == "warm-followup"]
        same_pid = len(warm) == 1 and warm[0]["physicalRequestPids"] == [row["pid"]]
        handoff.update(warmFollowupSamePid=same_pid, warmFollowupCacheRead=warm[0]["physicalTokens"]["cacheRead"] if warm else None)
        if not same_pid or not warm[0]["physicalTokens"]["cacheRead"]:
            failures.append("Physical receipt did not preserve warm same-PID cached follow-up")
        proof["handoffs"].append(handoff)
    proof["qualificationFailures"] = failures
    dump(output / "receipt-proof.json", proof)
    manifest["receiptProof"] = proof
    return failures


def receipt_fixture(source, output, shape):
    """Generate a proof-only extension; never edit the shared src/tests tree."""
    fixture = source / "tests/e2e/continuity-extension.ts"
    if shape not in ("image-derivative", "multi-text-error"):
        return fixture
    text = fixture.read_text()
    original = 'return { content: [{ type: "text", text: resultText }], ...(syntheticError ? { isError: true } : {}), details: { mode, toolCallId } };'
    if text.count(original) != 1:
        raise RuntimeError("Continuity fixture return contract changed; refusing an unqualified rewrite")
    # Fixture dimensions describe this synthetic workload, not acceptance limits.
    # Seeded high-entropy pixels force the real CLI's size-driven recompression.
    if shape == "image-derivative":
        # High-entropy 4-bit grayscale exercises both resizing and re-encoding
        # at those dimensions without external imagery or an image dependency.
        width, height = 4017, 2260
        row_bytes = (width + 1) // 2
        pixels = random.Random("continuity-image-derivative").randbytes(row_bytes * height)
        scanlines = b"".join(b"\0" + pixels[y * row_bytes:(y + 1) * row_bytes] for y in range(height))
        def chunk(kind, body):
            return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 4, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")
        image = output / "synthetic-receipt.png"
        image.write_bytes(png)
        # Import through the extension's resolver; the dependency link below is
        # to existing modules, not an installation or a package mutation.
        text = 'import { readFileSync } from "node:fs";\n' + text
        body = 'return { content: [{ type: "text", text: "SYNTHETIC-IMAGE-COMPANION" }, { type: "image", mimeType: "image/png", data: readFileSync(' + json.dumps(str(image)) + ').toString("base64") }], details: { mode, toolCallId } };'
    else:
        body = 'return { content: [{ type: "text", text: "    SYNTHETIC-ERROR-FIRST:é\\r\\nkeep internal CRLF" }, { type: "text", text: "SYNTHETIC-ERROR-SECOND:─ \\t\\r\\n" }], isError: true, details: { mode, toolCallId } };'
    text = text.replace(original, 'if (mode === "plain") { ' + body + ' }\n      ' + original)
    generated = output / "receipt-continuity-extension.ts"
    generated.write_text(text)
    (output / "node_modules").symlink_to((source / "node_modules").resolve(), target_is_directory=True)
    return generated


async def run(args):
    source = args.source_extension_dir.resolve()
    entry = source / "index.ts"
    fixture = source / "tests/e2e/continuity-extension.ts"
    if not entry.is_file() or not fixture.is_file():
        raise RuntimeError("Both source index.ts and continuity-extension.ts must exist")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("This node's Linux pidfd APIs are required for owned-PID cleanup")
    if args.installed_pi_bin:
        # Explicit updater-only exception; ordinary fixtures never infer this route.
        pi = Path(args.installed_pi_bin).resolve(strict=True)
        owned = resolve_owned_pi(None, source, allow_missing=True)
        expected_version = owned[1] if owned else SUPPORTED_INSTALLED_PI_VERSION
    else:
        pi, expected_version = resolve_owned_pi(args.pi_bin, source)
    if not pi.is_file() or not os.access(pi, os.X_OK):
        raise RuntimeError(f"Pi engine is not an executable file: {pi}")
    output = args.output_dir.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)  # Never overwrite a prior proof.
    for name in ("agent", "state", "config", "data", "cache", "runtime", "sessions", "work"):
        (output / name).mkdir(mode=0o700)
    fixture = receipt_fixture(source, output, args.receipt_shape)
    observer = output / "observe-cli.cjs"
    observer.write_text(OBSERVER)
    env = dict(os.environ)
    scrubbed = []
    for key in list(env):
        if (key.startswith(("PI_", "CONTINUITY_", "CLAUDE_", "ANTHROPIC_")) or
            key.endswith(("API_KEY", "AUTH_TOKEN", "ACCESS_TOKEN", "BEARER_TOKEN")) or
            key.startswith(("AWS_", "AZURE_", "OPENAI_", "OPENROUTER_", "GEMINI_", "GOOGLE_API_")) or
            key in ("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSLKEYLOGFILE", "CLAUDECODE", "CLAUDE_CONFIG_DIR")):
            scrubbed.append(key)
            del env[key]
    env.update(PI_CODING_AGENT_DIR=str(output / "agent"), PI_OFFLINE="1",
               XDG_STATE_HOME=str(output / "state"), XDG_CONFIG_HOME=str(output / "config"),
               XDG_DATA_HOME=str(output / "data"), XDG_CACHE_HOME=str(output / "cache"),
               XDG_RUNTIME_DIR=str(output / "runtime"), TMPDIR=str(output / "runtime"),
               PI_CLAUDE_CLI_STATE_DIR=str(output / "pcc-state"), CONTINUITY_TOOL_LOG=str(output / "tool-events.jsonl"),
               CONTINUITY_CLI_LOG=str(output / "cli-metadata.jsonl"),
               CONTINUITY_TRANSPORT="live" if args.live else "stub")
    if args.live:
        # Use the existing package-owned subscription profile.
        # Never clone credentials into isolated Pi/XDG state or fall back to ~/.claude.
        env["CLAUDE_CONFIG_DIR"] = str(package_data_dir(source, Path.home()) / "claude-config")
    if args.expected_cli_version:
        env["CONTINUITY_EXPECTED_CLI_VERSION"] = args.expected_cli_version
    if args.receipt_shape:
        env["CONTINUITY_RECEIPT_SHAPE"] = args.receipt_shape
    if args.failover:
        env["PI_CLAUDE_CLI_ACCOUNTS"] = "default,b"
        env["PI_CLAUDE_CLI_FAILOVER"] = "1"
        env["CONTINUITY_FAILOVER"] = "1"
        env["PI_CLAUDE_CLI_STATE_DIR"] = str(output / "pcc-state")
    if args.overage:
        env["CONTINUITY_OVERAGE"] = "1"
        if args.overage == "allow":
            env["PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS"] = "1"
    if args.seed_receipt_mismatch:
        env["CONTINUITY_RECEIPT_SEED"] = str(output / "receipt-mismatch.seed")
    if args.refresh_retry:
        env["CONTINUITY_REFRESH_RETRY"] = "1"
    if args.context:
        env["PI_CLAUDE_CLI_CONTEXT"] = args.context
    if args.stub_cli or args.stub:
        if args.stub:
            stub = output / "continuity-cli-stub.cjs"
            stub.write_text(STUB)
            stub.chmod(0o700)
        else:
            stub = args.stub_cli.resolve()
        env["CONTINUITY_STUB_LOG"] = str(output / "stub-events.jsonl")
        if not stub.is_file() or not os.access(stub, os.X_OK):
            raise RuntimeError("--stub-cli must name an executable compatible fixture")
        home = output / "home"
        private = package_data_dir(source, home) / "cli/node_modules/.bin"
        private.mkdir(parents=True, mode=0o700)
        (private / "claude").symlink_to(stub)
        env.update(HOME=str(home), PATH=str(private) + os.pathsep + env.get("PATH", ""))
    # Native retry policy is not replaced by a harness retry loop or invented budget.
    dump(output / "agent/settings.json", {"cacheWarming": "off", "compaction": {"enabled": False}})
    version_process = await asyncio.create_subprocess_exec(str(pi), "-ne", "--version", cwd=output / "work", env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    version_stdout, version_stderr = await version_process.communicate()
    version = version_stdout.decode().strip()
    dump(output / "pi-version.json", {"argv": [str(pi), "-ne", "--version"], "version": version, "exitCode": version_process.returncode, "stderrBytes": len(version_stderr)})
    if version != expected_version or version_process.returncode:
        raise RuntimeError(f"Required Pi {expected_version}; observed {version!r}")
    argv = [str(pi), "--mode", "rpc", "-ne", "-e", str(entry), "-e", str(fixture),
            "--provider", PROVIDER, "--model", MODEL, "--thinking", "off",
            "--session-dir", str(output / "sessions"), "--system-prompt", SYSTEM +
            (" When explicitly asked for a parallel pair, also call continuity_side in the same assistant message, before either result arrives." if args.parallel_handoff else ""),
            "--tools", "continuity_tool,continuity_side" if args.parallel_handoff else "continuity_tool", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp"]
    source_files = [entry, fixture, source / "tests/e2e/continuity-extension.ts", Path(__file__).resolve(), *sorted((source / "src").rglob("*.ts")), *sorted((source / "src").rglob("*.js")), *sorted((source / "src").rglob("*.cjs"))]
    manifest = {"status": "starting", **stamp(), "argv": argv, "piBinary": str(pi), "piResolved": str(pi.resolve()), "piSha256": sha(pi.resolve()), "piVersion": version, "sourceExtensionDir": str(source), "contextOverride": args.context, "scenarioSelection": args.scenario, "receiptShape": args.receipt_shape, "parallelHandoff": args.parallel_handoff, "seedReceiptMismatch": args.seed_receipt_mismatch, "overage": args.overage, "transport": env["CONTINUITY_TRANSPORT"], "scrubbedEnvironmentKeys": sorted(scrubbed), "isolatedState": {k: env[k] for k in ("PI_CODING_AGENT_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "PI_CLAUDE_CLI_STATE_DIR")}, "homePreservedForSubscription": args.live, "sourceHashes": {str(p): sha(p) for p in source_files}, "scenarios": []}
    if args.receipt_shape in ("image-derivative", "multi-text-error"):
        manifest["receiptFixture"] = {"shape": args.receipt_shape, "generatedExtension": str(fixture), "generatedExtensionSha256": sha(fixture)}
        if args.receipt_shape == "image-derivative":
            image = output / "synthetic-receipt.png"
            manifest["receiptFixture"].update(imageSha256=sha(image), imageBytes=image.stat().st_size, width=4017, height=2260)
    dump(output / "run.json", manifest)
    read_fd, write_fd = os.pipe()
    env.update(NODE_OPTIONS="--require=" + str(observer), CONTINUITY_OBSERVER_FD=str(write_fd))
    process = await asyncio.create_subprocess_exec(*argv, cwd=output / "work", env=env, pass_fds=(write_fd,), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
    os.close(write_fd)
    handles = {process.pid: os.pidfd_open(process.pid)}
    manifest["piPid"] = process.pid
    rpc = Rpc(process, output)
    observer_reader = asyncio.StreamReader()
    observer_protocol = asyncio.StreamReaderProtocol(observer_reader)
    observer_transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: observer_protocol, os.fdopen(read_fd, "rb", buffering=0))

    async def observations():
        try:
            async for raw in lines(observer_reader):
                row = json.loads(raw)
                if row.get("type") == "cli_spawn" and row.get("pid"):
                    try:
                        handles[row["pid"]] = os.pidfd_open(row["pid"])
                    except ProcessLookupError:
                        pass  # The actual spawn/exit metadata is still retained.
                await rpc.publish("cli", row)
        except BaseException as error:
            async with rpc.changed:
                rpc.failure = error
                rpc.changed.notify_all()

    async def diagnostics():
        # stderr can contain third-party diagnostics; retain size/hash, never credential-bearing text.
        with (output / "stderr-metadata.jsonl").open("w") as handle:
            async for raw in lines(process.stderr):
                handle.write(json.dumps({**stamp(), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}) + "\n")
                handle.flush()

    tasks = [asyncio.create_task(rpc.read()), asyncio.create_task(observations()), asyncio.create_task(diagnostics())]
    scenarios = manifest["scenarios"]

    async def start(name):
        rpc.phase = name
        scenario = {"name": name, "startMonoNs": str(time.monotonic_ns()), "startWall": time.time(), "rpcStartIndex": len(rpc.rows), "piStatsBefore": await rpc.command("get_session_stats")}
        scenarios.append(scenario)
        dump(output / "run.json", manifest)
        return scenario, len(rpc.rows)

    async def finish(scenario):
        expected_mode = {"baseline-tool": "plain", "abort-running-tool": "abort", "steer-during-running-tool": "steer", "failover-tool-rejection": "plain"}.get(scenario["name"])
        tools = [e["record"] for e in rpc.rows[scenario["rpcStartIndex"]:] if e["source"] == "rpc" and e["record"].get("type") == "tool_execution_start"]
        expected_tools = [("continuity_tool", {"mode": expected_mode})] if expected_mode else []
        if args.parallel_handoff and scenario["name"] == "baseline-tool":
            expected_tools.append(("continuity_side", {}))
        observed_tools = [(t.get("toolName"), t.get("args", {})) for t in tools]
        if sorted(observed_tools, key=lambda t: t[0]) != sorted(expected_tools, key=lambda t: t[0]):
            raise RuntimeError(f"Unexpected tool executions in {scenario['name']}: {tools}")
        scenario["toolExecutions"] = tools
        scenario["piStatsAfter"] = await rpc.command("get_session_stats")
        scenario["piStatsTokenDelta"] = {key: scenario["piStatsAfter"].get("tokens", {}).get(key, 0) - scenario["piStatsBefore"].get("tokens", {}).get(key, 0) for key in ("input", "output", "cacheWrite", "cacheRead")}
        scenario["endMonoNs"] = str(time.monotonic_ns())
        scenario["endWall"] = time.time()
        dump(output / "run.json", manifest)

    async def check_error_marker(since, substring):
        messages = [e["record"]["message"] for e in rpc.rows[since:] if e["source"] == "rpc" and e["record"].get("type") == "message_end" and e["record"].get("message", {}).get("role") == "assistant"]
        if not messages:
            raise RuntimeError("No finalized native assistant message")
        for message in messages:
            if message.get("provider") != PROVIDER or message.get("model") != MODEL:
                raise RuntimeError("Native assistant selected an unauthorized model/provider")
        last = messages[-1]
        if last.get("stopReason") != "error":
            raise RuntimeError(f"Expected a failed turn, observed stop {last.get('stopReason')!r}")
        text = (last.get("errorMessage") or "") + "".join(b.get("text", "") for b in last.get("content", []) if b.get("type") == "text")
        if substring not in text:
            raise RuntimeError(f"Expected {substring!r} in the failure; observed {text!r}")
        return text

    async def check_marker(since, marker, native_retry=False):
        messages = [e["record"]["message"] for e in rpc.rows[since:] if e["source"] == "rpc" and e["record"].get("type") == "message_end" and e["record"].get("message", {}).get("role") == "assistant"]
        if not messages:
            raise RuntimeError("No finalized native assistant message")
        for message in messages:
            if message.get("provider") != PROVIDER or message.get("model") != MODEL:
                raise RuntimeError("Native assistant selected an unauthorized model/provider")
            if message.get("responseModel") and message["responseModel"] != MODEL:
                raise RuntimeError("Native assistant physical response model differs")
            if message.get("stopReason") in ("error", "aborted"):
                if not (native_retry and message is not messages[-1] and message.get("stopReason") == "error" and ("timed out" in message.get("errorMessage", "").lower() or "failed to refresh oauth token" in message.get("errorMessage", "").lower())):
                    raise RuntimeError(f"Unexpected native assistant stop: {message.get('stopReason')}")
        text = "".join(b.get("text", "") for b in messages[-1].get("content", []) if b.get("type") == "text").strip()
        if text != marker:
            raise RuntimeError(f"Expected exactly {marker}; observed {text!r}")
        return text

    async def prompt(message):
        response = await rpc.command("prompt", message=message)
        if response.get("disposition") != "started":
            raise RuntimeError(f"Proof prompt did not start a native run: {response}")

    try:
        await rpc.fixture("fixture_ready")
        state = await rpc.command("get_state")
        manifest.update(sessionFile=state.get("sessionFile"), sessionId=state.get("sessionId"), selectedModel=state.get("model"))
        if state.get("model", {}).get("provider") != PROVIDER or state.get("model", {}).get("id") != MODEL:
            raise RuntimeError("Exact Haiku selection unavailable; no fallback authorized")
        auth = await rpc.wait(lambda e: e["source"] == "cli" and e["record"].get("type") == "auth_status")
        manifest["subscriptionMetadata"] = auth["record"]
        if args.live and not auth["record"].get("subscriptionVerified"):
            raise RuntimeError("Existing private profile has not proven Claude subscription authentication")
        await rpc.command("set_auto_compaction", enabled=False)
        scenario, cursor = await start("baseline-tool")
        await prompt('Call continuity_tool exactly once with mode "plain"' +
                     (' and continuity_side exactly once, as a parallel pair in the same assistant message' if args.parallel_handoff else '') +
                     ', then reply exactly BASELINE-OK.')
        await rpc.settled(cursor)
        await rpc.fixture("tool_return", "plain", cursor, True)
        scenario["marker"] = await check_marker(cursor, "BASELINE-OK")
        await finish(scenario)

        if args.scenario in ("all", "abort"):
            scenario, cursor = await start("abort-running-tool")
            await prompt('Call continuity_tool exactly once with mode "abort". If it ever returns, reply ABORT-OLD.')
            running = await rpc.fixture("tool_running", "abort", cursor, True)
            scenario["runningEvidence"] = fixture_data(running)
            await rpc.command("abort")  # Native RPC abort waits for idle; not a provider-only abort.
            aborted = await rpc.fixture("tool_abort_observed", "abort", cursor)
            if fixture_data(aborted)["toolCallId"] != scenario["runningEvidence"]["toolCallId"]:
                raise RuntimeError("Abort signal belongs to a different tool")
            settled = await rpc.settled(cursor)
            if settled["record"].get("aborted") is not True:
                raise RuntimeError("Native Pi did not report the run aborted")
            scenario["abortEvidence"] = fixture_data(aborted)
            await finish(scenario)

            scenario, cursor = await start("new-user-after-abort")
            await prompt("That tool was deliberately aborted. Do not retry it or call tools. Reply exactly ABORT-OK.")
            await rpc.settled(cursor)
            scenario["marker"] = await check_marker(cursor, "ABORT-OK")
            await finish(scenario)

        if args.scenario in ("all", "steer"):
            scenario, cursor = await start("steer-during-running-tool")
            await prompt('Call continuity_tool exactly once with mode "steer", then reply STEER-OLD unless a newer user message changes the marker.')
            running = await rpc.fixture("tool_running", "steer", cursor, True)
            scenario["runningEvidence"] = fixture_data(running)
            disposition = await rpc.command("prompt", message="/continuity-steer")
            if disposition.get("disposition") != "handled":
                raise RuntimeError("The native steer extension command was not handled immediately")
            queued = await rpc.fixture("steer_queued", since=cursor)
            if fixture_data(queued)["toolCallId"] != scenario["runningEvidence"]["toolCallId"]:
                raise RuntimeError("Steering queued outside the intended running tool")
            await rpc.settled(cursor)
            scenario["steerEvidence"] = fixture_data(queued)
            scenario["marker"] = await check_marker(cursor, "STEER-OK")
            await finish(scenario)

        scenario, cursor = await start("warm-followup")
        had_steer = args.scenario in ("all", "steer")
        warm_marker = fixture_data(await rpc.fixture("tool_return", "steer"))["resultText"] if had_steer else "WARM-OK"
        scenario["expectedToolResult"] = warm_marker if had_steer else None
        await prompt("Do not call tools. Recall the exact text returned by the most recent continuity_tool call, and reply only with that text." if had_steer else "Do not call tools. Reply exactly WARM-OK.")
        await rpc.settled(cursor)
        scenario["marker"] = await check_marker(cursor, warm_marker)
        await finish(scenario)
        if args.failover:
            # Zero-output rejection on the default profile fails over inside
            # the same provider call: the failed attempt pushes nothing, so
            # pi sees exactly one assistant message while two CLI processes
            # ran (the qualification below checks the spawns and ledger).
            scenario, cursor = await start("failover-limit")
            await prompt("Do not call tools. Reply exactly FAILOVER-OK.")
            await rpc.settled(cursor)
            failover_messages = [e["record"]["message"] for e in rpc.rows[cursor:] if e["source"] == "rpc" and e["record"].get("type") == "message_end" and e["record"].get("message", {}).get("role") == "assistant"]
            if len(failover_messages) != 1:
                raise RuntimeError(f"Failover must cost no extra Pi turn: {len(failover_messages)} final assistants")
            for message in failover_messages:
                if message.get("provider") != PROVIDER or message.get("model") != MODEL:
                    raise RuntimeError("Native assistant selected an unauthorized model/provider")
            final_text = "".join(b.get("text", "") for b in failover_messages[-1].get("content", []) if b.get("type") == "text").strip()
            if final_text != "FAILOVER-OK":
                raise RuntimeError(f"Expected exactly FAILOVER-OK; observed {final_text!r}")
            scenario["marker"] = final_text
            await finish(scenario)

            scenario, cursor = await start("failover-stays")
            await prompt("Do not call tools. Reply exactly STILL-B.")
            await rpc.settled(cursor)
            scenario["marker"] = await check_marker(cursor, "STILL-B")
            await finish(scenario)

            # A rejection that arrives after a tool ran must NOT replay: the
            # tool effect happened once, and the account is not marked.
            scenario, cursor = await start("failover-tool-rejection")
            await prompt('Call continuity_tool exactly once with mode "plain". FAILOVER-TOOL')
            await rpc.settled(cursor)
            scenario["marker"] = await check_error_marker(cursor, "weekly limit")
            await finish(scenario)

            # Still on b afterwards: the tool-rejection marked nothing.
            scenario, cursor = await start("failover-still-b")
            await prompt("Do not call tools. Reply exactly STILL-B.")
            await rpc.settled(cursor)
            scenario["marker"] = await check_marker(cursor, "STILL-B")
            await finish(scenario)
        if args.overage:
            # The stub bills this turn to overage, then answers normally.
            # Deny (default): the guard fails the turn with a non-retryable
            # usage-credits error. Allow: the opted-in turn succeeds.
            scenario, cursor = await start("overage-guard")
            await prompt("Do not call tools. Reply exactly OVERAGE-OK.")
            await rpc.settled(cursor)
            if args.overage == "allow":
                scenario["marker"] = await check_marker(cursor, "OVERAGE-OK")
            else:
                scenario["marker"] = await check_error_marker(cursor, "usage credits")
            await finish(scenario)
        if args.transient_retry or args.scenario == "transient":
            scenario, cursor = await start("native-transient-retry")
            await rpc.command("set_auto_retry", enabled=True)
            await prompt("CONTINUITY-RETRY. Do not call tools. Reply exactly RETRY-OK.")
            await rpc.settled(cursor)
            retry_events = [e["record"] for e in rpc.rows[cursor:] if e["source"] == "rpc" and e["record"].get("type") in ("auto_retry_start", "auto_retry_end")]
            if not any(e["type"] == "auto_retry_start" for e in retry_events) or not any(e["type"] == "auto_retry_end" and e.get("success") is True for e in retry_events):
                raise RuntimeError("Transient fixture did not cross native Pi retry scheduling and successful completion")
            scenario["nativeRetryEvents"] = retry_events
            scenario["marker"] = await check_marker(cursor, "RETRY-OK", native_retry=True)
            await finish(scenario)
        manifest["finalState"] = await rpc.command("get_state")
        await rpc.command("get_entries")
        manifest["status"] = "scenarios-passed"
    except BaseException as error:
        manifest["status"] = "failed"
        manifest["error"] = repr(error)
        manifest["cleanup"] = owned_cleanup(process.pid, handles)
        raise
    finally:
        rpc.phase = "shutdown"
        if process.returncode is None:
            if manifest["status"] == "scenarios-passed":
                process.stdin.close()
                try:
                    await process.stdin.wait_closed()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                owned_cleanup(process.pid, handles)
        await process.wait()
        await asyncio.gather(*tasks, return_exceptions=True)
        observer_transport.close()
        rpc.close()
        # Dispose any surviving OWNED children, never pkill/killall/global adapter state.
        manifest["finalCleanup"] = owned_cleanup(process.pid, handles)
        for fd in handles.values():
            os.close(fd)
        for journal in (output / "sessions").glob("*.jsonl"):
            shutil.copyfile(journal, output / ("journal-" + journal.name))
        if manifest.get("sessionFile") and Path(manifest["sessionFile"]).is_file():
            shutil.copyfile(manifest["sessionFile"], output / "journal.jsonl")
        ledger = output / f"state/{package_state_leaf(source)}/retire.log"
        if ledger.is_file():
            shutil.copyfile(ledger, output / "request-ledger.jsonl")
        measurements = analyze(output, scenarios, env["CONTINUITY_TRANSPORT"])
        manifest["exitCode"] = process.returncode
        manifest["end"] = stamp()
        manifest["sourceHashesAfter"] = {str(p): sha(p) for p in source_files if p.is_file()}
        qualification_failures = accounting_failures(measurements)
        if args.receipt_shape in ("image-derivative", "multi-text-error"):
            qualification_failures.extend(receipt_qualification(output, args.receipt_shape, measurements, manifest))
        if process.returncode != 0:
            qualification_failures.append("Native Pi did not exit cleanly")
        if measurements["physicalCoverageGaps"] or not measurements["physicalRequests"]:
            qualification_failures.append("Physical request accounting has explicit coverage gaps")
        expected_starts = 3 if args.failover else (2 if args.seed_receipt_mismatch or args.refresh_retry else 1)
        if measurements["totalCliStarts"] != expected_starts:
            qualification_failures.append("Unexpected main CLI process count for the requested seeded/non-seeded workload")
        cli_rows = [json.loads(line) for line in (output / "cli-metadata.jsonl").read_text().splitlines()]
        manifest["physicalCliVersions"] = [row for row in cli_rows if row.get("type") == "cli_version"]
        if args.expected_cli_version and (not manifest["physicalCliVersions"] or any(
                row.get("version") != args.expected_cli_version or row.get("code") != 0 for row in manifest["physicalCliVersions"])):
            qualification_failures.append("Exact physical CLI version was not proven")
        if args.seed_receipt_mismatch:
            seeds = [row for row in cli_rows if row.get("type") == "seeded_receipt_mismatch"]
            retired = [json.loads(line) for line in (output / "request-ledger.jsonl").read_text().splitlines()]
            mismatches = [row for row in retired if row.get("type") == "retire" and row.get("reasons") == ["handoff_receipt_mismatch"]]
            if len(seeds) != 1 or len(mismatches) != 1 or seeds[0]["pid"] != mismatches[0]["pid"]:
                qualification_failures.append("Seed did not cross exactly one real strict receipt retirement")
            starts = [row for row in cli_rows if row.get("type") == "cli_spawn" and not row.get("probe")]
            if len(starts) == 2:
                old_exit = [row for row in cli_rows if row.get("pid") == starts[0]["pid"] and row.get("type") in ("cli_exit", "cli_close")]
                if not old_exit or min(int(row["seq"]) for row in old_exit) >= int(starts[1]["seq"]):
                    qualification_failures.append("Replacement spawned before old-process termination was observed")
        if args.refresh_retry:
            stub_rows = [json.loads(line) for line in (output / "stub-events.jsonl").read_text().splitlines()]
            failures = [row for row in stub_rows if row.get("type") == "refresh_failure_before_model"]
            retries = [row for row in stub_rows if row.get("type") == "refresh_retry_received_user"]
            if len(failures) != 1 or len(retries) != 1 or failures[0]["pid"] == retries[0]["pid"]:
                qualification_failures.append("Refresh retry did not reimport the user through a new CLI after the seeded pre-model failure")
        if args.failover:
            qualification_failures.extend(failover_qualification(output, measurements, manifest))
        if args.overage:
            qualification_failures.extend(overage_qualification(output, measurements, manifest))
        if manifest["sourceHashesAfter"] != manifest["sourceHashes"]:
            qualification_failures.append("Source changed during proof; snapshot cannot qualify")
        manifest["qualificationFailures"] = qualification_failures
        if manifest["status"] == "scenarios-passed":
            if qualification_failures:
                manifest["status"] = "failed-qualification"
            else:
                manifest["status"] = "passed-live-proof" if args.live else "passed-stub-protocol-only"
        manifest["artifactHashes"] = {str(p.relative_to(output)): sha(p) for p in sorted(output.glob("*")) if p.is_file() and p.name != "run.json"}
        dump(output / "run.json", manifest)
    print(json.dumps({"status": manifest["status"], "output": str(output), "measurements": str(output / "measurements.json")}))
    if manifest["status"] not in ("passed-live-proof", "passed-stub-protocol-only"):
        raise RuntimeError("Qualification failed; inspect retained run.json and native events")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-extension-dir", type=Path, required=True, help="Candidate/baseline directory containing index.ts (explicit -ne -e)")
    parser.add_argument("--output-dir", type=Path, required=True, help="Fresh private artifact/state directory; must not exist")
    engine = parser.add_mutually_exclusive_group()
    engine.add_argument("--installed-pi-bin", help="Explicit installed Pi for stub qualification only; strict real path, executable and version checks; never a fixture fallback")
    engine.add_argument("--pi-bin", help="Explicit Pi binary override; its --version must equal the owned SDK version, else [owned-pi-engine-version-mismatch]. When omitted (or via PI_BIN), the owned devDependency engine resolves via scripts/resolve-pi-cli.mjs; no PATH fallback.")
    parser.add_argument("--context", choices=("pi", "legacy"), help="Optional adapter policy override; default is the source's own default")
    route = parser.add_mutually_exclusive_group(required=True)
    route.add_argument("--live", action="store_true", help="Use only existing private Claude Haiku subscription profile")
    route.add_argument("--stub", action="store_true", help="Embedded fail-closed deterministic CLI fixture, disposable HOME; native Pi RPC still real")
    route.add_argument("--stub-cli", type=Path, help="Executable continuity-compatible Claude fixture; disposable HOME, no live credential route")
    parser.add_argument("--failover", action="store_true", help="Stub-only multi-account failover: stub rejects under the default profile and answers under account b")
    parser.add_argument("--overage", choices=("deny", "allow"), help="Stub-only usage-credit guard: stub bills the turn to overage; deny expects the guard failure, allow expects success with PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1")
    parser.add_argument("--receipt-shape", choices=("synthetic-error", "error-outer-whitespace", "synthetic-read", "image-derivative", "multi-text-error", "long-error"), help="Synthetic failed-bash error, large read, image derivative, or multi-text error shape (generated fixture; src/tests unchanged)")
    parser.add_argument("--expected-cli-version", help="Exact physical CLI version required by this qualification")
    parser.add_argument("--parallel-handoff", action="store_true", help="Request two results in the same native handoff")
    parser.add_argument("--seed-receipt-mismatch", action="store_true", help="Rewrite one synthetic stdout receipt to prove transparent retirement/replay")
    parser.add_argument("--scenario", choices=("all", "abort", "steer", "transient", "receipt"), default="all", help="Independent continuity scenario; baseline-tool and warm-followup are always included")
    parser.add_argument("--transient-retry", action="store_true", help="Stub-only: synthesize one timeout then require native Pi parked retry")
    parser.add_argument("--refresh-retry", action="store_true", help="Stub-only: synthesize pre-model refresh contention and require native Pi retry")
    args = parser.parse_args()
    if args.installed_pi_bin and not (args.stub or args.stub_cli):
        parser.error("--installed-pi-bin is restricted to stub qualification")
    if args.refresh_retry:
        args.transient_retry = True
    if args.live and (args.transient_retry or args.scenario == "transient"):
        parser.error("Transient injection is a deterministic fixture workload, never a fabricated live timeout")
    if args.failover and not args.stub:
        parser.error("Failover is a stub-CLI scenario workload, never a fabricated live limit")
    if args.overage and not args.stub:
        parser.error("Overage is a stub-CLI scenario workload, never a fabricated live charge")
    if args.live and args.failover:
        parser.error("Failover proof never burns a real subscription limit")
    if args.live and args.overage:
        parser.error("Overage proof never burns real usage credits")
    if args.failover and args.overage:
        parser.error("Failover and overage scenarios run in separate proofs; their accounting is qualified independently")
    os.umask(0o077)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    task = loop.create_task(run(args))
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, task.cancel)
    try:
        loop.run_until_complete(task)
    finally:
        loop.close()


if __name__ == "__main__":
    main()
