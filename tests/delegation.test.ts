import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArgs, buildTemplateVars } from '../src/executors/commandBuilder.js';
import { parseStreamJsonLine } from '../src/executors/claude.js';
import { redactText, redactValue } from '../src/delegation/redact.js';
import { selectClaudeSession } from '../src/delegation/session.js';
import { loadConfig } from '../src/config/loader.js';

test('redacts common secret shapes without hiding normal details', () => {
  const text = redactText('Authorization: Bearer abcdefghijklmnop API_KEY=sk-abcdef123456 file=src/app.ts');
  assert.equal(text.includes('abcdefghijklmnop'), false);
  assert.equal(text.includes('sk-abcdef123456'), false);
  assert.match(text, /src\/app\.ts/);
  assert.deepEqual(redactValue({ password: 'hello', command: 'npm test' }), { password: '[已隐藏]', command: 'npm test' });
});

test('expands persistent Claude session arguments', () => {
  const context = {
    model: 'claude-test',
    allowedTools: 'Read',
    disallowedTools: ['Bash(rm *-r*)', 'Bash(*git clean *-f*)'],
    autoApprove: true,
    budgetUsd: 1,
    timeoutMs: 1000,
  };
  const first = buildArgs(['{sessionArgs}', '{promptArg}'], null, buildTemplateVars({
    prompt: 'do it', workdir: process.cwd(), session: { id: 'session-id', name: 'named' },
  }, context));
  assert.deepEqual(first.args, ['--session-id', 'session-id', '--name', 'named', 'do it']);
  const resumed = buildArgs(['{sessionArgs}', '{promptArg}'], null, buildTemplateVars({
    prompt: 'fix it', workdir: process.cwd(), session: { id: 'session-id', resume: true },
  }, context));
  assert.deepEqual(resumed.args, ['--resume', 'session-id', 'fix it']);
});

test('expands hard deny rules independently of full auto approval', () => {
  const context = {
    model: 'claude-test',
    allowedTools: 'Read,Edit,Bash',
    disallowedTools: ['Bash(rm *-r*)', 'Bash(*Remove-Item *-Recurse*)'],
    autoApprove: true,
    budgetUsd: 1,
    timeoutMs: 1000,
  };
  const preview = buildArgs(
    ['--permission-mode', 'bypassPermissions', '--disallowedTools', '{disallowedTools}', '{promptArg}'],
    null,
    buildTemplateVars({ prompt: 'implement', workdir: process.cwd() }, context),
  );
  assert.deepEqual(preview.args, [
    '--permission-mode',
    'bypassPermissions',
    '--disallowedTools',
    'Bash(rm *-r*)',
    'Bash(*Remove-Item *-Recurse*)',
    'implement',
  ]);
});

test('parses Claude tool results for the structured panel', () => {
  const events = parseStreamJsonLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tests passed', is_error: false }] },
  }));
  assert.deepEqual(events, [{ type: 'tool_result', toolUseId: 'tool-1', content: 'tests passed', isError: false }]);
});

test('surfaces Claude result errors in the structured panel', () => {
  const events = parseStreamJsonLine(JSON.stringify({
    type: 'result',
    is_error: true,
    errors: ["EPERM: cannot write Claude's session"],
  }));
  assert.deepEqual(events, [
    { type: 'stderr', text: "EPERM: cannot write Claude's session" },
    { type: 'status', status: 'failed', message: "EPERM: cannot write Claude's session" },
  ]);
});

test('never resumes a Claude session that did not reach init', () => {
  assert.deepEqual(
    selectClaudeSession('uncreated-id', false, false, () => 'fresh-id'),
    { id: 'fresh-id', resume: false },
  );
  assert.deepEqual(
    selectClaudeSession('real-id', true, false, () => 'unused-id'),
    { id: 'real-id', resume: true },
  );
  assert.deepEqual(
    selectClaudeSession('real-id', true, true, () => 'new-id'),
    { id: 'new-id', resume: false },
  );
});

test('marks delegated Claude sessions as smart2stupid instead of hidden SDK sessions', () => {
  const config = loadConfig();
  assert.equal(config.executors.claude.env?.CLAUDE_CODE_ENTRYPOINT, 'smart2stupid');
});
