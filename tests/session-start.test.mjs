import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { runInThisContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/(participant)/sessions/new/create-session-form.tsx", import.meta.url), "utf8");

function setup(autoStart) {
  const refs = [], effects = [];
  let submissions = 0;
  const hooks = {
    useActionState: () => [{ message: "" }, "existing-action", false],
    useRef: (initial) => {
      const ref = { current: initial };
      refs.push(ref);
      return ref;
    },
    useEffect: (effect) => effects.push(effect),
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const mocks = { react: hooks, "@/app/toast": { Toast: () => null }, "./actions": { createDraftSession: "existing-action" },
    "@/app/loading-state": { LoadingState: () => null },
    "@/lib/forms": { initialFormResult: { message: "" } } };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  const element = module.exports.CreateSessionForm({ autoStart });
  refs[0].current = { requestSubmit: () => { submissions++; } };
  return { element, effects, get submissions() { return submissions; } };
}

test("record page starts a new session with the existing explicit server action", () => {
  const s = setup(false);
  s.effects.forEach((effect) => effect());
  assert.equal(s.submissions, 0);
  assert.equal(s.element.props.action, "existing-action");
  assert.equal(s.element.props.children[0].props.children, "새 성찰 시작");
  const home = readFileSync(new URL("../src/app/(participant)/history/page.tsx", import.meta.url), "utf8");
  assert.match(home, /<CreateSessionForm \/>/);
  assert.match(home, /className="wizard-footer"/);
  assert.match(home, /className="wizard-actions home-start"/);
  assert.match(home, /select\("participant_code"\)\.eq\("id", user\.id\)\.single\(\)/);
  assert.match(home, /반가워요 :\) \{profile\.participant_code\} 디자이너님!/);
  assert.match(home, /if \(profileError \|\| !profile\?\.participant_code\)/);
  assert.doesNotMatch(home, /href="\/sessions\/new"/);
});

function loadPage(path, mocks) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  return module.exports.default;
}

test("home opens the latest owned unfinished session without inserting and creates only when empty", async () => {
  let data = [{ id: "latest-session" }], error = null;
  const calls = [];
  const query = {};
  for (const method of ["select", "eq", "neq", "order"]) query[method] = (...args) => {
    calls.push([method, ...args]); return query;
  };
  query.limit = async () => ({ data, error });
  const Form = () => null;
  const Page = loadPage("../src/app/(participant)/page.tsx", {
    "@/lib/auth/role": { requireRole: async () => ({ user: { id: "owner" }, supabase: { from: () => query } }) },
    "next/navigation": { redirect: (path) => { throw new Error(`REDIRECT:${path}`); } },
    "./sessions/new/create-session-form": { CreateSessionForm: Form },
  });
  await assert.rejects(Page(), /REDIRECT:\/sessions\/latest-session/);
  assert.ok(calls.some((call) => call.join(":") === "eq:participant_id:owner"));
  assert.ok(calls.some((call) => call.join(":") === "neq:status:completed"));
  assert.ok(calls.some((call) => call[0] === "order" && call[1] === "updated_at" && !call[2].ascending));
  data = [];
  const page = await Page();
  const pageChildren = Array.isArray(page.props.children) ? page.props.children : [page.props.children];
  const form = pageChildren.find((node) => node?.type === Form);
  assert.equal(form.props.autoStart, true);
  error = { message: "DB failure" };
  await assert.rejects(Page(), /Unable to load/);
});

test("record page renders all owned sessions newest-work first with completion colors, categories and numbered links", async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const categories = loadPageOptions();
  const rows = [
    { id: "new", status: "summary_ready", created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-07T02:03:04Z",
      primary_category_id: "ux_ui", subcategory_id: "web_design", other_category_text: null },
    { id: "old", status: "completed", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-06T01:00:00Z",
      primary_category_id: "others", subcategory_id: "other", other_category_text: "직접 분류" },
    { id: "blank", status: "draft", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-10-05T01:00:00Z",
      primary_category_id: null, subcategory_id: null, other_category_text: null },
  ];
  const calls = [];
  let fail = false;
  const supabase = { from(table) {
    const query = {};
    for (const method of ["select", "eq", "order"]) query[method] = (...args) => {
      calls.push([table, method, ...args]); return query;
    };
    query.single = async () => ({ data: { participant_code: "P07" }, error: null });
    query.then = (resolve) => resolve({ count: 2, error: null });
    query.range = async () => ({ data: fail ? null : rows, error: fail ? {} : null });
    return query;
  } };
  const Page = loadPage("../src/app/(participant)/history/page.tsx", {
    "next/link": { default: ({ children, ...props }) => React.createElement("a", props, children), __esModule: true },
    "@/lib/auth/role": { requireRole: async () => ({ user: { id: "owner" }, supabase }) },
    "../activity-marker": { ActivityMarker: () => null },
    "../sessions/new/create-session-form": { CreateSessionForm: () => null },
    "@/lib/constants/research-options": categories,
  });
  const html = renderToStaticMarkup(await Page());
  assert.match(html, /반가워요 :\) P07 디자이너님!/);
  assert.match(html, /UX\/UI &gt; 웹 디자인/);
  assert.match(html, /기타 &gt; 직접 분류/);
  assert.match(html, /디자인 분류 미선택/);
  assert.match(html, /is-progress/);
  assert.match(html, /is-completed/);
  assert.match(html, /3번 성찰 이어하기/);
  assert.match(html, /2번 성찰 상세보기/);
  assert.match(html, /1번 성찰 이어하기/);
  assert.ok(html.indexOf('/sessions/new"') < html.indexOf('/sessions/old"'));
  assert.match(html, /11:03:04/);
  assert.equal(calls.filter((call) => call[1] === "eq" && call[2] === "participant_id")
    .every((call) => call[3] === "owner"), true);
  fail = true;
  await assert.rejects(Page(), /Unable to load reflection records/);
});

function loadPageOptions() {
  const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/constants/research-options.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(module,exports){${compiled}\n})`)(module, module.exports);
  return module.exports;
}

test("completed session detail loads the saved question result without mounting the editable wizard", async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let queried = 0;
  const Page = loadPage("../src/app/(participant)/sessions/[sessionId]/page.tsx", {
    "next/navigation": { notFound() { throw new Error("NOT_FOUND"); } },
    "next/link": { default: ({ children, ...props }) => React.createElement("a", props, children), __esModule: true },
    "@/lib/auth/role": { requireRole: async () => ({ user: { id: "owner" }, supabase: { from() {
      queried++;
      const query = { select() { return query; }, eq() { return query; },
        async maybeSingle() { return { data: { status: "completed", summary_text: "최종 요약\n두 번째 줄" }, error: null }; } };
      return query;
    } } }) },
    "../../activity-marker": { ActivityMarker: () => null },
    "@/lib/errors/catalog": { errorCatalog: {} },
    "./session-wizard": { SessionWizard() { throw new Error("Completed session must not mount wizard"); } },
    "./question-result": { QuestionResult: () => React.createElement("section", null,
      "생각을 돌아보는 질문", React.createElement("a", { href: "/history" }, "나의기록으로"),
      React.createElement("p", null, "디자인 브리핑")) },
    "@/lib/question-generation/read": { readGenerationView: async () => ({
      state: "completed", session_id: sessionId, questions: [], images: [],
    }) },
    "@/app/toast": { Toast: () => null },
  });
  const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ sessionId }), searchParams: Promise.resolve({}) }));
  assert.match(html, /생각을 돌아보는 질문/);
  assert.match(html, /디자인 브리핑/);
  assert.doesNotMatch(html, /최종 요약/);
  assert.match(html, /href="\/history"/);
  assert.doesNotMatch(html, /textarea|다음|질문 생성하기/);
  assert.equal(queried, 1);
});

test("direct new-session route starts once even if Strict Mode replays the effect", () => {
  const s = setup(true);
  assert.equal(s.element.props.children[0].type.name, "LoadingState");
  assert.equal(s.element.props.children[0].props.children, "이전 작업을 확인하고 새 성찰을 준비하고 있어요.");
  assert.notEqual(s.element.props.children[0].type, "button");
  s.effects.forEach((effect) => { effect(); effect(); });
  assert.equal(s.submissions, 1);
  const page = readFileSync(new URL("../src/app/(participant)/sessions/new/page.tsx", import.meta.url), "utf8");
  assert.match(page, /autoStart label="다시 시도"/);
  assert.doesNotMatch(page, /디자인 작업 준비|이미지 등록 시작/);
});
