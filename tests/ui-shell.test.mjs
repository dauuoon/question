import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { window: originalWindow } = globalThis;
function load(path, mocks) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}
function nodes(element) {
  if (Array.isArray(element)) return element.flatMap(nodes);
  if (!element || typeof element !== "object") return [];
  return [element, ...[element.props?.children].flat().flatMap((child) => nodes(child))];
}

test("shared navigation toggles all menus including logout and remounts on pathname change", () => {
  let path = "/", open = false;
  const hooks = {
    useState: () => [open, (value) => { open = value; }],
    useId: () => "header-nav-test",
    useRef: () => ({ current: null }), useEffect() {},
  };
  const { HeaderMenu } = load("../src/app/header-menu.tsx", {
    react: hooks, "next/navigation": { usePathname: () => path },
  });
  const children = ["home", "history", "logout"];
  let outer = HeaderMenu({ label: "참여자 메뉴", children });
  const render = () => nodes(outer.type(outer.props));
  let tree = render();
  const toggle = () => tree.find((node) => node.type === "button");
  assert.equal(toggle().props["aria-expanded"], false);
  toggle().props.onClick(); tree = render();
  assert.equal(toggle().props["aria-expanded"], true);
  const nav = tree.find((node) => node.type === "nav");
  assert.equal(nav.props.className, "menu-open");
  assert.deepEqual(nav.props.children, children);
  assert.equal(nav.props.id, toggle().props["aria-controls"]);
  path = "/history";
  const next = HeaderMenu({ label: "참여자 메뉴", children });
  assert.notEqual(next.key, outer.key);
});

test("toast registry auto-dismisses errors with exit animation and preserves confirmation actions without X", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let notices = {}, registry;
  const cleanups = [];
  const hooks = {
    createContext: () => ({ Provider: "provider" }),
    useState: () => [notices, (update) => { notices = update(notices); }],
    useMemo: (factory) => factory(),
    useContext: () => registry,
    useId: () => "notice-test",
    useEffect: (effect) => cleanups.push(effect()),
  };
  const { ToastProvider, Toast } = load("../src/app/toast.tsx", { react: hooks });
  registry = ToastProvider({ children: "page" }).props.value;
  Toast({ message: "저장 실패", error: true });
  const render = () => nodes(ToastProvider({ children: "page" })).flatMap((node) =>
    typeof node.type === "function" ? nodes(node.type(node.props)) : [node]);
  let tree = render();
  assert.equal(tree.find((node) => node.props?.role === "alert").props.className, "toast-box toast-error");
  assert.equal(tree.some((node) => node.type === "button"), false);
  t.mock.timers.tick(8000);
  tree = render();
  assert.match(tree.find((node) => node.props?.role === "alert").props.className, /is-exiting/);
  t.mock.timers.tick(240);
  assert.deepEqual(notices, {});
  const action = { type: "button", props: { children: "확인" } };
  Toast({ message: "교체하시겠어요?", error: false, action });
  tree = render();
  assert.ok(tree.find((node) => node.props?.role === "status"));
  assert.equal(tree.find((node) => node.props?.className === "toast-actions").props.children, action);
  t.mock.timers.tick(10000);
  assert.ok(notices["notice-test"]);
  for (const cleanup of [...cleanups]) cleanup?.();
  render();
  t.mock.timers.tick(240);
  assert.deepEqual(notices, {});
  Toast({ message: "이미지를 불러오는 중입니다…", error: false, persistent: true });
  t.mock.timers.tick(10000);
  assert.equal(notices["notice-test"].exiting, undefined);
  cleanups.at(-1)?.();
  render();
  t.mock.timers.tick(240);
  assert.deepEqual(notices, {});
});

test("custom grouped dropdown selects stable IDs, closes and exposes accessible state", () => {
  let open = false, chosen;
  const options = load("../src/lib/constants/research-options.ts", {});
  const { CategorySelect } = load("../src/app/category-select.tsx", {
    "@/lib/constants/research-options": options,
    react: { useState: () => [open, (value) => { open = value; }], useId: () => "list-test",
      useRef: () => ({ current: null }), useEffect() {} },
  });

  test("scroll header hides downward, reveals upward and keeps focused navigation visible", () => {
    let hidden = false, handler, cleanup;
    const header = { contains: () => false, querySelector: () => null };
    globalThis.window = { scrollY: 0, addEventListener: (_, fn) => { handler = fn; },
      removeEventListener: (_, fn) => { assert.equal(fn, handler); } };
    const originalDocument = globalThis.document;
    globalThis.document = { activeElement: {} };
    try {
      const { ScrollHeader } = load("../src/app/scroll-header.tsx", {
        react: { useState: () => [hidden, (value) => { hidden = value; }],
          useRef: () => ({ current: header }), useEffect: (effect) => { cleanup = effect(); } },
      });
      const tree = ScrollHeader({ children: "menus" });
      globalThis.window.scrollY = 100; handler(); assert.equal(hidden, true);
      globalThis.window.scrollY = 60; handler(); assert.equal(hidden, false);
      header.contains = () => true;
      globalThis.window.scrollY = 200; handler(); assert.equal(hidden, false);
      header.contains = () => false;
      globalThis.window.scrollY = 300; handler(); assert.equal(hidden, true);
      tree.props.onFocusCapture(); assert.equal(hidden, false);
      globalThis.window.scrollY = 0; handler(); assert.equal(hidden, false);
      cleanup();
    } finally { globalThis.window = originalWindow; globalThis.document = originalDocument; }
  });
  const props = { id: "subcategory", value: "web_design", disabled: false, onChange: (value) => { chosen = value; } };
  let tree = nodes(CategorySelect(props));
  const trigger = tree.find((node) => node.props?.id === "subcategory");
  assert.equal(trigger.props["aria-expanded"], false);
  trigger.props.onClick();
  tree = nodes(CategorySelect(props));
  assert.equal(tree.find((node) => node.props?.role === "listbox").props.id, "list-test");
  assert.equal(tree.filter((node) => node.props?.role === "group").length, 7);
  const entries = tree.filter((node) => node.props?.role === "option");
  assert.equal(entries.filter((node) => node.props["aria-selected"]).length, 1);
  entries.at(-1).props.onClick();
  assert.equal(chosen, "other");
  assert.equal(open, false);
  tree = nodes(CategorySelect({ ...props, disabled: true }));
  assert.equal(tree.find((node) => node.props?.id === "subcategory").props.disabled, true);
});

test("responsive shell and gauge use tablet breakpoint, bottom centering and reduced motion", () => {
  const css = readFileSync(new URL("../src/app/app.css", import.meta.url), "utf8");
  const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 1024px\)/);
  for (const path of ["../src/app/(participant)/layout.tsx", "../src/app/(admin)/admin/layout.tsx"]) {
    const layout = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(layout, /<img src="\/images\/icon.png" width="32" height="32" alt="" \/>/);
  }
  const root = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  assert.match(root, /icons: \{ icon: "\/images\/icon.png"/);
  assert.match(css, /@media \(max-width: 1024px\) \{\s*\.image-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(globals, /\.context-textarea textarea \{[^}]*min-height: 12rem/);
  assert.match(globals, /\.context-ai-help span \{ transform: translateY\(2px\)/);
  assert.match(css, /\.menu-toggle\.button-secondary \{[^}]*place-items: center;[^}]*height: 2\.75rem; padding: 0;/);
  assert.match(css, /\.home-start \{[^}]*justify-content: flex-end/);
  assert.match(css, /\.toast-stack \{[^}]*position: fixed;[^}]*left: 50%;[^}]*bottom:/s);
  assert.match(globals, /\.step-gauge-fill \{[^}]*transition: width 450ms ease/);
  assert.match(globals, /prefers-reduced-motion: reduce/);
  assert.match(globals, /transition-duration: 0.01ms !important/);
  assert.match(css, /\.toast-box[^}]*box-shadow: none/s);
  assert.match(css, /\.toast-box \{[^}]*border: 0;/s);
  assert.doesNotMatch(css, /\.toast-error \{[^}]*border-color/);
  assert.match(css, /@keyframes toast-enter/);
  assert.match(css, /@keyframes toast-exit/);
  assert.match(css, /\.upload-file-input \{ display: none/);
  assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.image-preview img[^}]*aspect-ratio: 1/s);
  assert.match(css, /\.paste-shortcut kbd/);
  assert.match(globals, /\.wizard-footer \{[^}]*position: fixed;[^}]*bottom: 0/s);
  assert.match(globals, /\.reflection-choices \{ background: #ffffff/);
  assert.match(globals, /\.session-context\.work-info,[^}]*border: 0;/);
  assert.match(globals, /\.reflection-choices input\[type="checkbox"\]:checked[^}]*background-color: #000000/);
  assert.match(globals, /stroke='white'/);
  assert.match(css, /body:has\(\.wizard-footer\) \.theme-floating/);
  assert.match(css, /\.participant-home \.notice-card \{ background: var\(--color-primary-light\)/);
  assert.match(css, /\.participant-home \.notice-card \{[^}]*border-color: var\(--color-primary\)/);
  assert.match(css, /\.button-secondary \{[^}]*border: 1px solid var\(--color-border\)/);
  assert.match(css, /\.image-dropzone \{[^}]*min-height: 25rem/s);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.image-dropzone \{[^}]*--color-text-primary: inherit;[^}]*background: var\(--color-surface\);[^}]*border-color: var\(--color-text-muted\)/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.image-dropzone\.is-dragging \{[^}]*background: var\(--color-primary-light\);[^}]*border-color: var\(--color-primary\)/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.paste-shortcut kbd \{[^}]*background: var\(--color-background\);[^}]*color: var\(--color-text-secondary\)/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.context-ai-help \{ color: #ffffff/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.context-ai-help \.ai-icon-dark \{ display: block/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.reflection-choices \{[^}]*background: var\(--color-surface\);[^}]*color: var\(--color-text-primary\)/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.reflection-choices input\[type="checkbox"\]:checked \{[^}]*background-color: #ffffff;[^}]*border-color: #ffffff;[^}]*stroke='%23202024'/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.reflection-choices \.context-choice:has\(input:not\(:checked\)\) \{ opacity: 0\.65/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.reflection-choices \.context-choice:has\(input:not\(:checked\):disabled\) \{ opacity: 0\.4/);
  assert.match(css, /\.participant-shell\[data-theme="dark"\] \.category-trigger\.button-secondary\[data-selected="true"\]:hover:not\(:disabled\) \{[^}]*background: var\(--color-primary-light\);[^}]*color: var\(--color-text-primary\)/);
  assert.match(css, /\.category-trigger\.button-secondary \{[^}]*align-items: center;[^}]*padding: var\(--space-3\) var\(--space-4\)/);
  assert.match(css, /\.category-option:hover[^}]*background: var\(--color-primary-light\)/);
  assert.match(css, /\.category-trigger\.button-secondary\[data-selected="true"\] \{[^}]*border-color: var\(--color-primary\); color: #000000/);
  assert.match(css, /\.category-trigger\.button-secondary:hover:not\(:disabled\) \{ background: #ffffff; opacity: 0\.85/);
  assert.match(css, /body:has\(\.wizard-footer\) \.theme-floating \{ bottom: calc\(4\.75rem/);
  assert.match(css, /body:has\(\.wizard-footer\) \.toast-stack \{ bottom: calc\(4\.75rem/);
  assert.match(globals, /\.work-info \.context-fields legend \{ margin-bottom: var\(--space-4\)/);
  const login = readFileSync(new URL("../src/app/(auth)/login/page.tsx", import.meta.url), "utf8");
  assert.match(login, /디자이너를 위한 AI 질문 생성 도구/);
  assert.doesNotMatch(login, /WHY BOX · AI 질문 생성 도구/);
  const uploader = readFileSync(new URL("../src/app/(participant)/sessions/[sessionId]/image-uploader.tsx", import.meta.url), "utf8");
  assert.match(uploader, /파일을 선택하거나 여기로 끌어다 놓으세요\.<\/span>\s*<small className="upload-format">JPG · PNG \/ 최대 10MB<\/small>/);
});
