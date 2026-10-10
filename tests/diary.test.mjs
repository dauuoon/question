import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { Response } = globalThis;
function load(path) {
  const url = new URL(`../${path}`, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    name => name === "react" ? React : name.startsWith("@/")
      ? load(`src/${name.slice(2)}.ts`)
      : name.startsWith(".") ? load(new URL(`${name}.ts`, url).pathname.slice(new URL("../", import.meta.url).pathname.length))
        : require(name), module, module.exports);
  return module.exports;
}

const contract = load("src/lib/diaries/contract.ts");
const { DiaryPanel } = load("src/app/(participant)/sessions/[sessionId]/diary-panel.tsx");

test("diary contract requires specified Q1/Q2 choices and enforces exclusive no-change options", () => {
  const valid = {
    experience_choices: [contract.diaryExperienceChoices[0]],
    feeling_choices: [contract.diaryFeelingChoices[0]],
    free_text: null,
  };
  assert.equal(contract.diarySubmissionSchema.safeParse(valid).success, true);
  assert.equal(contract.diarySubmissionSchema.safeParse({
    ...valid, experience_choices: ["特別한 변화는 없었다", contract.diaryExperienceChoices[0]],
  }).success, false);
  assert.equal(contract.diarySubmissionSchema.safeParse({
    ...valid, feeling_choices: ["특별한 느낌이 없었어요", contract.diaryFeelingChoices[0]],
  }).success, false);
  assert.equal(contract.diarySubmissionSchema.safeParse({
    ...valid, experience_choices: [contract.diaryExperienceChoices[0], contract.diaryExperienceChoices[0]],
  }).success, false);
  assert.equal(contract.diarySubmissionSchema.safeParse({
    ...valid, feeling_choices: [],
  }).success, false);
  assert.equal(contract.diarySubmissionSchema.safeParse({
    ...valid, extra: "not in the research specification",
  }).success, false);
});

test("diary entry point renders while diary prompt options stay behind the dialog", () => {
  const html = renderToStaticMarkup(React.createElement(DiaryPanel, {
    sessionId: "20000000-0000-4000-8000-000000000001", active: false,
  }));
  assert.match(html, /다이어리 작성/u);
  assert.match(html, /유저 다이어리\(연구용\)/u);
  assert.doesNotMatch(html, /이번 질문을 통해 어떤 경험을 했나요/u);
});

test("diary timer cancels on leaving the briefing, claims once, preserves input and submits", async t => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost:3000" });
  const originalGlobals = new Map(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true, writable: true },
    document: { value: dom.window.document, configurable: true, writable: true },
    navigator: { value: dom.window.navigator, configurable: true, writable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
  });
  const scheduled = new Map();
  let timerId = 0;
  dom.window.setTimeout = callback => { const id = ++timerId; scheduled.set(id, callback); return id; };
  dom.window.clearTimeout = id => scheduled.delete(id);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) return new Response(JSON.stringify({ errorCode: "DIARY-DB" }), { status: 503 });
    const body = JSON.parse(options.body);
    if (body.action === "claim_prompt") return new Response(JSON.stringify({ claimed: true }), { status: 200 });
    return new Response(JSON.stringify({ submitted: true, submitted_at: "2026-10-12T10:00:00.000Z" }), { status: 200 });
  });
  const { createRoot } = await import("react-dom/client");
  const host = dom.window.document.getElementById("root");
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const sessionId = "20000000-0000-4000-8000-000000000001";
  const savedDraft = {
    experience_choices: [contract.diaryExperienceChoices[0]],
    feeling_choices: [contract.diaryFeelingChoices[0]],
    free_text: "Previously saved diary draft",
  };
  assert.equal(contract.diaryDraftSchema.safeParse(savedDraft).success, true);
  dom.window.localStorage.setItem(`why-box:diary-draft:${sessionId}`, JSON.stringify(savedDraft));
  const render = active => root.render(React.createElement(DiaryPanel, { sessionId, active }));
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
  await React.act(async () => { render(true); await settle(); });
  assert.equal(scheduled.size, 1);
  const cancelledId = [...scheduled.keys()][0];
  await React.act(async () => { render(false); await settle(); });
  assert.equal(scheduled.has(cancelledId), false);
  await React.act(async () => { render(true); await settle(); });
  const timer = [...scheduled.values()][0];
  await React.act(async () => { timer(); await settle(); });
  assert.ok(host.querySelector('[role="dialog"]'));
  assert.equal(host.querySelector("#diary-title").textContent, "유저 다이어리(연구용)");
  assert.equal(host.querySelector("#diary-description").textContent, "연구에 도움이 되는 소중한 기록이니, 사용 후 잠시만 시간을 내어 간단한 다이어리를 작성해 주시면 감사하겠습니다.");
  assert.equal(host.querySelector('[role="dialog"]').getAttribute("aria-describedby"), "diary-description");
  assert.equal(host.querySelector(".diary-modal-heading button"), null);
  const legends = [...host.querySelectorAll("form legend")];
  assert.equal(legends.length, 2);
  assert.ok(legends.every(legend => legend.textContent.includes("(복수선택)") && legend.textContent.endsWith("*")));
  assert.equal(host.querySelectorAll(".diary-required[aria-label='필수']").length, 2);
  assert.doesNotMatch(host.textContent, /복수 선택 · 필수/u);
  assert.equal(host.querySelector(".diary-actions button[type='button']").textContent, "닫기");
  assert.equal(host.querySelector(".diary-actions button[type='submit']").textContent, "제출 하기");
  assert.equal(host.querySelector("textarea")?.value, "Previously saved diary draft");
  assert.match(host.textContent, /이 기기에 보관된 임시 다이어리 내용을 복구했어요/u);
  assert.equal(calls.filter(call => JSON.parse(call.options.body ?? "{}").action === "claim_prompt").length, 1);
  const submit = host.querySelector('button[type="submit"]');
  await React.act(async () => { submit.click(); await settle(); });
  const submitted = calls.find(call => JSON.parse(call.options.body ?? "{}").action === "submit");
  assert.ok(submitted);
  assert.equal(JSON.parse(submitted.options.body).diary.experience_choices.length, 1);
  assert.equal(JSON.parse(submitted.options.body).diary.feeling_choices.length, 1);
  assert.match(host.textContent, /다이어리를 제출했어요/u);
  const close = host.querySelector(".diary-readonly .diary-actions button");
  assert.equal(close?.textContent, "닫기");
  await React.act(async () => { close.click(); await settle(); });
  assert.equal(host.querySelector('[role="dialog"]'), null);
});

test("diary uses the once-per-session claim, local draft recovery and the explicit spec wording", () => {
  const source = readFileSync(new URL("../src/app/(participant)/sessions/[sessionId]/diary-panel.tsx", import.meta.url), "utf8");
  assert.match(source, /10_000/u);
  assert.match(source, /claim_prompt/u);
  assert.match(source, /localStorage\.setItem/u);
  assert.match(source, /localStorage\.getItem/u);
  assert.match(source, /setOpen\(false\)\}>닫기/u);
  assert.match(source, /Q3\. 이번 사용에서 기억에 남는 점이 있다면 자유롭게 남겨주세요/u);
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.diary-modal fieldset \{[^}]*padding:0; border:0;/u);
  assert.match(css, /\.diary-modal legend \{[^}]*font-weight:var\(--font-weight-bold\)[^}]*text-align:left/u);
  assert.match(css, /\.diary-free-text > span \{[^}]*font-weight:var\(--font-weight-semibold\)[^}]*text-align:left/u);
  assert.match(css, /\.diary-actions > button \{[^}]*flex:1 1 0/u);
  assert.match(css, /\.diary-actions > \.button-secondary \{[^}]*background:var\(--color-surface\); border:1px solid var\(--color-border\)/u);
  assert.match(css, /\.diary-actions > \.button-secondary:hover:not\(:disabled\) \{ background:var\(--color-surface\); opacity:\.85; \}/u);
  assert.match(css, /\.reflection-choices input\[type="checkbox"\],\.diary-choice input\[type="checkbox"\] \{ appearance: none;/u);
  assert.match(css, /\.reflection-choices input\[type="checkbox"\]:checked,\.diary-choice input\[type="checkbox"\]:checked \{ border-color: #000000; background-color: #000000;/u);
  assert.match(css, /\.diary-modal fieldset \+ fieldset,\.diary-modal fieldset \+ \.diary-free-text \{ margin-top:var\(--space-2\); \}/u);
});

test("diary HTTP route uses authenticated caller access and does not enable admin edits", () => {
  const source = readFileSync(new URL("../src/app/api/sessions/[sessionId]/diary/route.ts", import.meta.url), "utf8");
  assert.match(source, /requireActiveParticipant/u);
  assert.match(source, /hasSameOrigin/u);
  assert.match(source, /claim_session_diary_prompt/u);
  assert.match(source, /status:\s*"submitted"/u);
  assert.doesNotMatch(source, /createSupabaseAdminClient/u);
});

test("admin session detail is a read-only view of current session research records", () => {
  const source = readFileSync(new URL("../src/app/(admin)/admin/sessions/[sessionId]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /requireRole\("admin"\)/u);
  assert.match(source, /session_briefing_sources/u);
  assert.match(source, /session_briefing_versions/u);
  assert.match(source, /diaries/u);
  assert.doesNotMatch(source, /\.insert\(|\.update\(|<form/u);
});
