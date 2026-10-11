import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  mocks = { "@/app/toast": { Toast: () => null }, "next/navigation": { useRouter: () => ({ push() {} }) }, ...mocks };
  mocks["@/app/category-select"] = { CategorySelect: ({ id, value, disabled }) => require("react").createElement(
    "select", { id, value, disabled }, options.DESIGN_CATEGORIES.flatMap((group) => group.items.map((item) =>
      require("react").createElement("option", { key: item.id, value: item.id }, item.label)))) };
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] :
      name === "@/lib/session-completion/display-state" ?
        load("../src/lib/session-completion/display-state.ts") : require(name), module, module.exports,
  );
  return module.exports;
}
const options = load("../src/lib/constants/research-options.ts");
const input = load("../src/lib/session-context/input.ts", { "../constants/research-options": options });
const { ContextAutosave } = load("../src/lib/session-context/autosave.ts", { "./input": input });
const wizard = load("../src/lib/session-context/wizard.ts", { "../constants/research-options": options });
const draftContract = load("../src/lib/ai/context-draft-contract.ts", {
  "../session-context/input": input, "../session-context/wizard": wizard,
});
const empty = {
  primary_category_id: null, subcategory_id: null, other_category_text: null,
  stage_id: null, additional_context: null, context_ids: [],
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("partial drafts, all stable category pairings, stages, contexts and optional blank text are valid", () => {
  assert.equal(input.sessionContextSchema.safeParse(empty).success, true);
  for (const category of options.DESIGN_CATEGORIES) for (const sub of category.items) {
    assert.equal(input.sessionContextSchema.safeParse({
      ...empty, primary_category_id: category.id, subcategory_id: sub.id,
    }).success, true);
  }
  for (const stage of options.WORK_STAGES) {
    assert.equal(input.sessionContextSchema.safeParse({ ...empty, stage_id: stage.id }).success, true);
  }
  for (const context of options.REFLECTION_CONTEXTS) {
    assert.equal(input.sessionContextSchema.safeParse({ ...empty, context_ids: [context.id] }).success, true);
  }
});

test("invalid IDs, mismatched children, duplicates, fourth selection and unexpected fields are rejected", () => {
  for (const patch of [
    { primary_category_id: "unknown" }, { subcategory_id: "web_design" },
    { primary_category_id: "brand_graphic", subcategory_id: "web_design" },
    { other_category_text: "Other" }, { stage_id: "unknown" },
    { context_ids: ["visual_form", "visual_form"] }, { context_ids: ["unknown"] },
    { context_ids: options.REFLECTION_CONTEXTS.slice(0, 4).map((c) => c.id) },
    { participant_id: "client supplied owner" }, { status: "completed" },
  ]) assert.equal(input.sessionContextSchema.safeParse({ ...empty, ...patch }).success, false);
});

test("1,000-character boundary counts Unicode code points consistently with PostgreSQL char_length", () => {
  for (const char of ["가", "a", "😀", "\n"]) {
    const valid = char.repeat(1000);
    assert.equal(input.characterCount(valid), 1000);
    assert.equal(input.sessionContextSchema.safeParse({ ...empty, additional_context: valid }).success, true);
    assert.equal(input.sessionContextSchema.safeParse({ ...empty, additional_context: valid + char }).success, false);
  }
  assert.equal(input.contextKey({ ...empty, additional_context: "" }), input.contextKey(empty));
  assert.equal(input.contextKey({ ...empty, context_ids: ["visual_form", "next_steps"] }),
    input.contextKey({ ...empty, context_ids: ["next_steps", "visual_form"] }));
});

test("typing waits a full second after the last edit; same values do not save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], states = [];
  const saver = new ContextAutosave(empty, async (value) => {
    calls.push(value);
    return { success: true, changed: true, activityRecorded: true };
  }, (state) => states.push(state));
  saver.change({ ...empty, additional_context: "처음" }, 1000);
  t.mock.timers.tick(700);
  saver.change({ ...empty, additional_context: "최신" }, 1000);
  t.mock.timers.tick(999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].additional_context, "최신");
  assert.equal(states.at(-1).status, "저장됨");
  assert.equal(saver.dirty, false);
  saver.change({ ...empty, additional_context: "최신" }, 1000);
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 1);
  saver.dispose();
});

test("in-flight saves serialize edits, preserve the last typing debounce and save latest snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], resolvers = [];
  const saver = new ContextAutosave(empty, (value) => {
    calls.push(value);
    return new Promise((resolve) => resolvers.push(resolve));
  }, () => {});
  saver.change({ ...empty, stage_id: "idea_concept" }, 200);
  t.mock.timers.tick(200);
  saver.change({ ...empty, stage_id: "idea_concept", additional_context: "최신 맥락" }, 1000);
  resolvers[0]({ success: true, changed: true, activityRecorded: true });
  await settle();
  t.mock.timers.tick(999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].additional_context, "최신 맥락");
  resolvers[1]({ success: true, changed: true, activityRecorded: true });
  await settle();
  assert.equal(saver.dirty, false);
  saver.dispose();
});

test("expired queued edits are sent after first completion, never in parallel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], resolvers = [];
  const saver = new ContextAutosave(empty, (v) => {
    calls.push(v); return new Promise((resolve) => resolvers.push(resolve));
  }, () => {});
  saver.change({ ...empty, stage_id: "idea_concept" }, 200);
  t.mock.timers.tick(200);
  saver.change({ ...empty, stage_id: "review_improvement" }, 200);
  t.mock.timers.tick(200);
  assert.equal(calls.length, 1);
  resolvers[0]({ success: true, changed: true, activityRecorded: true });
  await settle();
  assert.equal(calls.length, 2);
  resolvers[1]({ success: true, changed: true, activityRecorded: true });
  await settle();
  saver.dispose();
});

test("failed/ambiguous saves retain latest edits, pause automatic writes and retry even a reverted value", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], states = [];
  const saver = new ContextAutosave(empty, async (v) => {
    calls.push(v);
    if (calls.length === 1) throw new Error("lost response after possible commit");
    return { success: true, changed: false, activityRecorded: true };
  }, (s) => states.push(s));
  saver.change({ ...empty, additional_context: "실패한 초안" }, 1000);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(states.at(-1).status, "저장 실패");
  saver.change(empty, 1000);
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 1);
  assert.equal(saver.dirty, true);
  saver.retry();
  await settle();
  assert.deepEqual(calls[1], empty);
  assert.equal(states.at(-1).status, "저장됨");
  assert.equal(saver.dirty, false);
  saver.dispose();
});

test("activity failure warns without changing persisted success; disposal cancels pending timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [], calls = [];
  const saver = new ContextAutosave(empty, async (v) => {
    calls.push(v); return { success: true, changed: true, activityRecorded: false };
  }, (s) => states.push(s));
  saver.change({ ...empty, stage_id: "idea_concept" }, 200);
  t.mock.timers.tick(200);
  await settle();
  assert.equal(states.at(-1).status, "저장됨");
  assert.match(states.at(-1).message, /SAVE-002/);
  assert.equal(saver.dirty, false);
  saver.change({ ...empty, stage_id: "review_improvement" }, 200);
  saver.dispose();
  t.mock.timers.tick(200);
  assert.equal(calls.length, 1);
});

function actionSetup({ changed = true, rpcError = null, user = true, role = "participant", status = "active", activity = true } = {}) {
  const calls = { rpc: [], activity: [], errors: [] };
  const query = {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { role, status }, error: null }; },
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: user ? { id: "TEST-owner" } : null }, error: null }) },
    from: () => query,
    rpc: async (...args) => { calls.rpc.push(args); return { data: changed, error: rpcError }; },
  };
  const action = load("../src/app/(participant)/sessions/[sessionId]/context-actions.ts", {
    "@/lib/supabase/server": { createSupabaseServerClient: async () => client },
    "@/lib/errors/report": { reportError: async (...args) => {
      calls.errors.push(args); return { message: "TEST safe error" };
    } },
    "@/lib/activity/record": { recordParticipantActivity: async (kind) => { calls.activity.push(kind); return activity; } },
    "@/lib/session-context/input": input,
    "@/lib/question-generation/view-contract": { questionCountSchema: require("zod").z.number().int().min(1).max(5) },
  });
  return { calls, save: action.saveSessionContext };
}
const sessionId = "20000000-0000-4000-8000-000000000001";

test("server action uses caller RPC; only changed successful saves record activity", async () => {
  for (const changed of [true, false]) {
    const s = actionSetup({ changed });
    assert.deepEqual(await s.save(sessionId, empty), { success: true, changed, activityRecorded: true });
    assert.equal(s.calls.rpc.length, 1);
    assert.equal(s.calls.rpc[0][0], "save_session_context");
    assert.equal(s.calls.rpc[0][1].p_session_id, sessionId);
    assert.equal(Object.hasOwn(s.calls.rpc[0][1], "participant_id"), false);
    assert.deepEqual(s.calls.activity, changed ? ["context_saved"] : []);
  }
  const s = actionSetup({ activity: false });
  assert.deepEqual(await s.save(sessionId, empty), { success: true, changed: true, activityRecorded: false });
});

test("invalid inputs, inactive/Admin/anonymous requests, RPC failure or malformed response never record activity", async () => {
  const invalid = actionSetup();
  assert.equal((await invalid.save("invalid", empty)).success, false);
  assert.equal((await invalid.save(sessionId, { ...empty, additional_context: "가".repeat(1001) })).success, false);
  assert.equal(invalid.calls.rpc.length, 0);
  for (const options of [{ user: false }, { role: "admin" }, { status: "deactivated" },
    { rpcError: { code: "PGRST202" } }, { changed: null }]) {
    const s = actionSetup(options);
    assert.equal((await s.save(sessionId, empty)).success, false);
    assert.equal(s.calls.activity.length, 0);
    assert.ok(s.calls.errors.length > 0);
  }
});

test("form renders persisted choices, read-only controls and Unicode counter without server calls", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { SessionContextForm } = load("../src/app/(participant)/sessions/[sessionId]/session-context-form.tsx", {
    "@/lib/constants/research-options": options,
    "@/lib/session-context/input": input,
    "@/lib/session-context/autosave": { ContextAutosave },
    "@/lib/session-context/context-draft-controller": { ContextDraftController: class {} },
    "@/lib/ai/context-draft-contract": draftContract,
    "./context-actions": { saveSessionContext: async () => { throw new Error("SSR must not save"); } },
  });
  const html = renderToStaticMarkup(React.createElement(SessionContextForm, {
    sessionId, editable: false, activeStep: 3,
    initial: { ...empty, primary_category_id: "others", subcategory_id: "other",
      other_category_text: "직접 입력", additional_context: "😀한", context_ids: ["visual_form"] },
  }));
  assert.match(html, /질문 생성 이후/);
  assert.match(html, /fieldset disabled/);
  assert.match(html, /디자인 분류 직접 입력/);
  assert.match(html, /<legend>디자인 작업 단계<\/legend>/);
  assert.match(html, /2 \/ 1,000자/);
  assert.match(html, /class="context-textarea"/);
  assert.match(html, /id="context-count" class="context-character-count"/);
  assert.match(html, /aria-label="작업 맥락"/);
  assert.doesNotMatch(html, /작업 맥락 \(선택\)/);
  assert.match(html, /src="\/images\/ai.png"/);
  assert.match(html, /AI가 입력된 정보를 바탕으로 작업 맥락을 작성했어요/);
  assert.doesNotMatch(html, /확인한 내용은 질문 생성에 함께 반영됩니다/);
  assert.match(html, /checked/);
  assert.doesNotMatch(html, /저장 다시 시도/);
  const editableHtml = renderToStaticMarkup(React.createElement(SessionContextForm, {
    sessionId, editable: true, activeStep: 3, initial: empty,
  }));
  assert.match(editableHtml, /<button[^>]*hidden=""[^>]*>AI로 다시 작성 ↻<\/button>/);
});

test("grouped subcategory selection derives primary, clears other text and caps unique contexts and text", () => {
  const slots = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (v) => { slots[i] = v; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect() {},
  };
  const { SessionContextForm } = load("../src/app/(participant)/sessions/[sessionId]/session-context-form.tsx", {
    react: hooks,
    "@/lib/constants/research-options": options,
    "@/lib/session-context/input": input,
    "@/lib/session-context/autosave": { ContextAutosave },
    "@/lib/session-context/context-draft-controller": { ContextDraftController: class {} },
    "@/lib/ai/context-draft-contract": draftContract,
    "./context-actions": { saveSessionContext: async () => { throw new Error("test has no effect"); } },
  });
  function render() {
    cursor = 0;
    const nodes = [];
    function visit(element) {
      if (Array.isArray(element)) return element.forEach(visit);
      if (!element || typeof element !== "object") return;
      nodes.push(element);
      visit(element.props?.children);
    }
    visit(SessionContextForm({ sessionId, editable: true, activeStep: 2, initial: {
      ...empty, primary_category_id: "others", subcategory_id: "other", other_category_text: "기존 기타",
    } }));
    return nodes;
  }
  let nodes = render();
  assert.equal(nodes.some((n) => n.props?.id === "primary-category"), false);
  nodes.find((n) => n.props?.id === "subcategory").props.onChange("web_design");
  nodes = render();
  assert.equal(nodes.find((n) => n.props?.id === "subcategory").props.value, "web_design");
  assert.equal(slots[0].primary_category_id, "ux_ui");
  assert.equal(slots[0].other_category_text, null);
  assert.equal(nodes.some((n) => n.props?.id === "other-category"), false);
  nodes.find((n) => n.props?.id === "subcategory").props.onChange("web_design");
  assert.equal(slots[0].subcategory_id, "web_design");
  nodes.find((n) => n.props?.id === "subcategory").props.onChange("graphic_design");
  assert.equal(slots[0].primary_category_id, "brand_graphic");
  nodes.find((n) => n.props?.id === "subcategory").props.onChange("other");
  nodes = render();
  assert.equal(slots[0].primary_category_id, "others");
  assert.ok(nodes.find((n) => n.props?.id === "other-category"));
  const stage = nodes.find((n) => n.type === "input" && n.props?.type === "radio" && n.props.value === "structure_design");
  stage.props.onChange();
  assert.equal(slots[0].stage_id, "structure_design");
  nodes = render();
  const boxes = nodes.filter((n) => n.type === "input" && n.props.type === "checkbox");
  for (const index of [0, 0, 1, 2, 3]) boxes[index].props.onChange({ target: { checked: true } });
  assert.equal(slots[0].context_ids.length, 3);
  nodes = render();
  const updatedBoxes = nodes.filter((n) => n.type === "input" && n.props.type === "checkbox");
  assert.equal(updatedBoxes[0].props.disabled, false);
  assert.equal(updatedBoxes[3].props.disabled, true);
  updatedBoxes[0].props.onChange({ target: { checked: false } });
  assert.equal(slots[0].context_ids.length, 2);
  nodes.find((n) => n.props?.id === "additional-context").props.onChange({ target: { value: "😀".repeat(1001) } });
  assert.equal(input.characterCount(slots[0].additional_context), 1000);
  nodes = render();
  assert.equal(nodes.find((n) => n.props?.id === "additional-context").props.value, "😀".repeat(1000));
});

test("migration is an invoker-only transactional delta with exact stable ID options and no policy/storage edits", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261005190000_session_context_save.sql", import.meta.url), "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /security invoker/);
  assert.doesNotMatch(sql, /security definer|create policy|alter policy|drop policy|storage\.|alter table|create table/i);
  assert.match(sql, /for update;/);
  assert.match(sql, /s\.participant_id = auth\.uid\(\)/);
  assert.match(sql, /p\.role = 'participant' and p\.status = 'active'/);
  assert.match(sql, /exists \(select 1 from public\.questions/);
  assert.match(sql, /char_length\(coalesce\(context_text, ''\)\) > 1000/);
  assert.match(sql, /return false;/);
  assert.match(sql, /not \(sc\.context_id = any\(new_contexts\)\)/);
  assert.match(sql, /to authenticated;/);
  const json = JSON.parse(sql.match(/category_options constant jsonb := '([\s\S]*?)';/)[1]);
  assert.deepEqual(json, Object.fromEntries(options.DESIGN_CATEGORIES.map((c) => [c.id, c.items.map((s) => s.id)])));
  for (const id of [...options.WORK_STAGES, ...options.REFLECTION_CONTEXTS].map((o) => o.id)) {
    assert.ok(sql.includes(`'${id}'`), id);
  }
});

test("wizard validates only current-step required fields without changing partial-draft save validation", () => {
  const valid = { ...empty, primary_category_id: "ux_ui", subcategory_id: "web_design", stage_id: "idea_concept", context_ids: ["visual_form"] };
  assert.match(wizard.validateSessionStep(1, empty, null), /이미지 목록/);
  assert.match(wizard.validateSessionStep(1, empty, 0), /1개 이상/);
  assert.equal(wizard.validateSessionStep(1, empty, 1), null);
  for (const patch of [
    { primary_category_id: null }, { subcategory_id: null },
    { subcategory_id: "graphic_design" }, { stage_id: null },
    { stage_id: "unknown" },
    { primary_category_id: "others", subcategory_id: "other", other_category_text: "  " },
  ]) assert.ok(wizard.validateSessionStep(2, { ...valid, ...patch }, 1));
  assert.equal(wizard.validateSessionStep(2, valid, 0), null);
  assert.equal(wizard.validateSessionStep(2, {
    ...valid, primary_category_id: "others", subcategory_id: "other", other_category_text: "직접 작성",
  }, 1), null);
  assert.ok(wizard.validateSessionStep(2, { ...valid, context_ids: [] }, 1));
  for (const context_ids of [["visual_form", "visual_form"], ["unknown"], options.REFLECTION_CONTEXTS.slice(0, 4).map((c) => c.id)]) {
    assert.ok(wizard.validateSessionStep(2, { ...valid, context_ids }, 1));
  }
  assert.equal(wizard.validateSessionStep(3, empty, 1), null);
  assert.equal(input.sessionContextSchema.safeParse(empty).success, true);
});

test("wizard retains component positions, validates Next, exposes progress and gates final CTA", (t) => {
  const oldWindow = globalThis.window;
  const stored = new Map();
  globalThis.window = { addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } };
  const oldDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = oldWindow; });
  t.after(() => { globalThis.document = oldDocument; });
  const slots = [];
  const effects = [];
  let initialRender = true;
  let cursor = 0;
  const hooks = {
    useEffect(effect) { if (initialRender) effects.push(effect); },
    useCallback: (callback) => callback,
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (v) => { slots[i] = v; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
  };
  const ImageUploader = () => null;
  const SessionContextForm = () => null;
  const { SessionWizard } = load("../src/app/(participant)/sessions/[sessionId]/session-wizard.tsx", {
    react: hooks,
    "@/lib/session-context/wizard": wizard,
    "./image-uploader": { ImageUploader },
    "./session-context-form": { SessionContextForm },
    "@/lib/session-context/autosave": { Autosave: class { dispose() {} } },
    "@/lib/session-context/input": input,
    "@/lib/question-generation/view-contract": { questionCountSchema: { safeParse: () => ({ success: true }) } },
    "@/lib/question-generation/controller": { GenerationController: class { attach() {} detach() {} }, recoveryMessage: "TEST" },
    "./context-actions": { saveQuestionCount() {} },
    "./question-generation-loading": { QuestionGenerationLoading: () => null },
    "./question-result": { QuestionResult: () => null },
  });
  function render() {
    cursor = 0;
    const nodes = [];
    function visit(element) {
      if (Array.isArray(element)) return element.forEach(visit);
      if (!element || typeof element !== "object") return;
      nodes.push(element);
      visit(element.props?.children);
    }
    visit(SessionWizard({ sessionId, initial: empty, initialGeneration: {
      session_id: sessionId, state: "editable", requested_question_count: 3, questions: [], failed_request_id: null, answer_editable:false,
      question_actions:{ready:false,reserve_count:0},
    } }));
    if (initialRender) {
      initialRender = false;
      assert.ok(nodes.some((n) => n.props?.children === "마지막 작업 단계를 불러오고 있어요."));
      for (const effect of effects) effect();
      return render();
    }
    assert.equal(nodes.filter((n) => n.type === ImageUploader).length, 1);
    assert.equal(nodes.filter((n) => n.type === SessionContextForm).length, 1);
    assert.equal(nodes.filter((n) => n.props?.role === "progressbar").length, 1);
    assert.equal(nodes.find((n) => n.props?.role === "progressbar").props["aria-valuenow"], slots[0]);
    assert.equal(nodes.find((n) => n.props?.role === "progressbar").props["aria-valuemax"], 3);
    return nodes;
  }
  const button = (nodes, text) => nodes.find((n) => n.type === "button" && n.props.children === text);
  let nodes = render();
  assert.equal(button(nodes, "이전"), undefined);
  assert.equal(nodes.find((n) => n.props?.children === "나가기").props.href, "/history");
  button(nodes, "다음").props.onClick();
  assert.equal(slots[0], 1);
  nodes = render();
  nodes.find((n) => n.type === ImageUploader).props.onImageCountChange(1);
  nodes = render();
  button(nodes, "다음").props.onClick();
  nodes = render();
  assert.equal(slots[0], 2);
  assert.equal(nodes.find((n) => n.props?.className === "wizard-panel").props.hidden, true);
  button(nodes, "다음").props.onClick();
  assert.equal(slots[0], 2);
  nodes = render();
  const valid = { ...empty, primary_category_id: "ux_ui", subcategory_id: "web_design", stage_id: "idea_concept" };
  nodes.find((n) => n.type === SessionContextForm).props.onValueChange(valid);
  nodes = render();
  button(nodes, "다음").props.onClick();
  nodes = render();
  assert.equal(slots[0], 2);
  nodes.find((n) => n.type === SessionContextForm).props.onValueChange({ ...valid, context_ids: ["visual_form"] });
  nodes = render();
  button(nodes, "다음").props.onClick();
  nodes = render();
  assert.equal(slots[0], 3);
  assert.equal(stored.get(wizard.sessionStepStorageKey(sessionId)), "3");
  assert.equal(button(nodes, "다음"), undefined);
  assert.equal(button(nodes, "질문 생성하기").props.disabled, true);
  assert.doesNotMatch(JSON.stringify(nodes), /generation-unavailable|작업 맥락은 선택 입력입니다/);
  nodes.find((n) => n.type === SessionContextForm).props.onValueChange(empty);
  nodes = render();
  button(nodes, "이전").props.onClick();
  nodes = render();
  assert.equal(slots[0], 2);
  button(nodes, "이전").props.onClick();
  nodes = render();
  assert.equal(slots[0], 1);
  assert.equal(stored.get(wizard.sessionStepStorageKey(sessionId)), "1");
  assert.equal(nodes.find((n) => n.props?.className === "wizard-panel").props.hidden, false);
  const contextForm = nodes.find((n) => n.type === SessionContextForm);
  const savedAt = "2026-10-05T18:00:00.000Z";
  contextForm.props.onSaveStateChange({ status: "저장됨", message: "", savedAt });
  nodes = render();
  assert.equal(nodes.find((n) => n.type === "time").props.dateTime, savedAt);
  let retried = false;
  contextForm.props.onRetryReady(() => { retried = true; });
  contextForm.props.onSaveStateChange({ status: "저장 실패", message: "TEST" });
  nodes = render();
  button(nodes, "저장 다시 시도").props.onClick();
  assert.equal(retried, true);
});

test("wizard restores session-specific steps before mounting AI form and explicitly reports storage failures", (t) => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = oldWindow; });
  t.after(() => { globalThis.document = oldDocument; });
  const key = wizard.sessionStepStorageKey(sessionId);
  for (const value of [null, "1", "2", "3", "4", "invalid", "blocked"]) {
    const slots = [], effects = [], reads = [];
    let cursor = 0, initialRender = true;
    globalThis.window = { addEventListener() {}, removeEventListener() {}, localStorage: {
      getItem(name) { reads.push(name); if (value === "blocked") throw new Error("TEST denied"); return value; },
      setItem() { throw new Error("TEST denied"); },
    } };
    const hooks = {
      useCallback: (callback) => callback,
      useEffect(effect) { if (initialRender) effects.push(effect); },
      useState(initial) {
        const i = cursor++;
        if (!(i in slots)) slots[i] = initial;
        return [slots[i], (next) => { slots[i] = next; }];
      },
      useRef(initial) {
        const i = cursor++;
        if (!(i in slots)) slots[i] = { current: initial };
        return slots[i];
      },
    };
    const SessionContextForm = () => null;
    const { SessionWizard } = load("../src/app/(participant)/sessions/[sessionId]/session-wizard.tsx", {
      react: hooks, "@/lib/session-context/wizard": wizard,
      "./image-uploader": { ImageUploader: () => null }, "./session-context-form": { SessionContextForm },
      "@/lib/session-context/autosave": { Autosave: class { dispose() {} } },
      "@/lib/session-context/input": input,
      "@/lib/question-generation/view-contract": { questionCountSchema: { safeParse: () => ({ success: true }) } },
      "@/lib/question-generation/controller": { GenerationController: class { attach() {} detach() {} }, recoveryMessage: "TEST" },
      "./context-actions": { saveQuestionCount() {} },
      "./question-generation-loading": { QuestionGenerationLoading: () => null },
      "./question-result": { QuestionResult: () => null },
    });
    function render() {
      cursor = 0;
      const nodes = [];
      function visit(element) {
        if (Array.isArray(element)) return element.forEach(visit);
        if (!element || typeof element !== "object") return;
        nodes.push(element); visit(element.props?.children);
      }
      visit(SessionWizard({ sessionId, initial: empty, initialGeneration: {
        session_id: sessionId, state: "editable", requested_question_count: 3, questions: [], failed_request_id: null, answer_editable:false,
        question_actions:{ready:false,reserve_count:0},
      } }));
      return nodes;
    }
    assert.ok(!render().some((n) => n.type === SessionContextForm));
    initialRender = false;
    // Strict Mode replay must only read, not overwrite the stored step.
    for (const effect of effects) { effect(); effect(); }
    let nodes = render();
    const expected = value === "2" ? 2 : value === "3" ? 3 : 1;
    assert.equal(nodes.find((n) => n.type === SessionContextForm).props.activeStep, expected);
    assert.deepEqual(reads, [key, key]);
    if (["4", "invalid", "blocked"].includes(value)) {
      assert.ok(nodes.some((n) => /마지막 단계를 불러오지 못해/.test(n.props?.message ?? "")));
    }
    if (expected > 1) {
      nodes.find((n) => n.type === "button" && n.props.children === "이전").props.onClick();
      nodes = render();
      assert.ok(nodes.some((n) => /현재 단계를 이 브라우저에 저장하지 못했습니다/.test(n.props?.message ?? "")));
      assert.equal(nodes.find((n) => n.type === SessionContextForm).props.activeStep, expected - 1);
    }
  }
  assert.notEqual(key, wizard.sessionStepStorageKey("another-session"));
});

test("form panels hide only presentation and keep persisted values and global save status on every step", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { SessionContextForm } = load("../src/app/(participant)/sessions/[sessionId]/session-context-form.tsx", {
    "@/lib/constants/research-options": options,
    "@/lib/session-context/input": input,
    "@/lib/session-context/autosave": { ContextAutosave },
    "@/lib/session-context/context-draft-controller": { ContextDraftController: class {} },
    "@/lib/ai/context-draft-contract": draftContract,
    "./context-actions": { saveSessionContext: async () => { throw new Error("SSR must not save"); } },
  });

  test("save timestamps advance only on confirmed changed saves and stay stable on no-op", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initialSavedAt = "2026-10-05T18:00:00.000Z";
    const states = [];
    const saver = new ContextAutosave(empty, async () => ({ success: true, changed: true, activityRecorded: true }),
      (state) => states.push(state), initialSavedAt);
    saver.change(empty, 200);
    assert.equal(states.at(-1).savedAt, initialSavedAt);
    saver.change({ ...empty, stage_id: "idea_concept" }, 200);
    assert.equal(states.at(-1).status, "저장 중");
    t.mock.timers.tick(200); await settle();
    const confirmed = states.at(-1).savedAt;
    assert.equal(states.at(-1).status, "저장됨");
    assert.ok(Number.isFinite(Date.parse(confirmed)));
    assert.notEqual(confirmed, initialSavedAt);
    saver.change({ ...empty, stage_id: "idea_concept" }, 200);
    assert.equal(states.at(-1).savedAt, confirmed);
    saver.dispose();
  });
  const initial = { ...empty, primary_category_id: "ux_ui", subcategory_id: "web_design",
    stage_id: "idea_concept", additional_context: "저장된 맥락", context_ids: ["visual_form"] };
  for (const activeStep of [1, 2, 3]) {
    const html = renderToStaticMarkup(React.createElement(SessionContextForm, { sessionId, editable: true, activeStep, initial }));
    assert.equal((html.match(/<(?:div|fieldset)[^>]*hidden=""/g) ?? []).length, activeStep === 1 ? 2 : 1);
    assert.match(html, /value="web_design" selected/);
    assert.match(html, /type="radio"[^>]*checked=""[^>]*value="idea_concept"/);
    assert.match(html, /저장된 맥락/);
    assert.match(html, /checked/);
    assert.match(html, /저장됨/);
    const workPanel = html.slice(html.indexOf('class="session-context work-info'), html.indexOf('class="context-fields wizard-panel"'));
    assert.match(workPanel, /점검하고 싶은 부분/);
    assert.match(workPanel, /type="checkbox"/);
    assert.match(workPanel, /class="context-fields reflection-group"><legend>점검하고 싶은 부분[^<]*<\/legend><div class="context-fields reflection-choices">/);
  }
});
