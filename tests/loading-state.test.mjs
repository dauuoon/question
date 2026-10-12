import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path) {
  const url = new URL(`../${path}`, import.meta.url);
  const source = readFileSync(url, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    name => name.startsWith("react") ? require(name) : require(name), module, module.exports);
  return module.exports;
}

test("overlay tips rotate on a timer and unmount clears the timer", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const cleared = [];
  const clear = globalThis.clearInterval;
  globalThis.clearInterval = timer => { cleared.push(timer); return clear(timer); };
  t.after(() => { globalThis.clearInterval = clear; });
  const { LoadingState, LOADING_TIPS } = load("src/app/loading-state.tsx");
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const originals = {};
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const { createRoot } = await import("react-dom/client");
  const host = dom.window.document.getElementById("root");
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(LoadingState,
    { variant: "overlay" }, "질문을 생성하고 있어요···")); });
  const tip = host.querySelector(".loading-state-tip");
  assert.equal(tip.textContent, `Tip. ${LOADING_TIPS[0]}`);
  assert.ok(tip.classList.contains("is-visible"));
  await act(async () => { t.mock.timers.tick(4500); });
  assert.equal(tip.classList.contains("is-visible"), false);
  await act(async () => { t.mock.timers.tick(220); });
  assert.equal(tip.textContent, `Tip. ${LOADING_TIPS[1]}`);
  assert.ok(tip.classList.contains("is-visible"));
  assert.match(readFileSync("src/app/globals.css", "utf8"), /min-height: 3em;[\s\S]*transition: opacity 220ms ease/u);
  assert.match(readFileSync("src/app/globals.css", "utf8"), /prefers-reduced-motion: reduce[\s\S]*loading-state-overlay \.loading-state-tip \{ transition:none; \}/u);
  await act(async () => { root.unmount(); });
  assert.equal(cleared.length, 1);
  dom.window.close();
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});
