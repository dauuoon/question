import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
function load(path) {
  const url = new URL(`../${path}`, import.meta.url);
  const source = readFileSync(url, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    name => name === "@/app/toast" ? { Toast: () => null } :
      name === "@/lib/manual" ? load("src/lib/manual.ts") :
      name.startsWith("@/") ? load(`src/${name.slice(2)}.tsx`) :
        name.startsWith(".") ? load(new URL(`${name}.tsx`, url).pathname.replace(
          new URL("../", import.meta.url).pathname, "")) : require(name), module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function withDom(t, children) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/login" });
  const originals = {};
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement, FormData: dom.window.FormData,
    location: dom.window.location, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const { createRoot } = await import("react-dom/client");
  const host = dom.window.document.getElementById("root");
  const root = createRoot(host);
  await act(async () => { root.render(children); });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { dom, host };
}

test("login click and native Enter submission show pending state and suppress duplicate submits", async t => {
  const { LoginForm } = load("src/app/(auth)/login/login-form.tsx");
  const waits = [deferred(), deferred()];
  const submissions = [];
  const action = async formData => {
    submissions.push([formData.get("identifier"), formData.get("password")]);
    await waits[submissions.length - 1].promise;
  };
  const ui = await withDom(t, React.createElement(LoginForm, { action }));
  const id = ui.host.querySelector("#identifier");
  const password = ui.host.querySelector("#password");
  id.value = "T01";
  password.value = "not-a-real-password";
  const button = ui.host.querySelector('button[type="submit"]');

  await act(async () => { button.click(); await Promise.resolve(); });
  assert.deepEqual(submissions, [["T01", "not-a-real-password"]]);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.textContent, "로그인 중");
  assert.equal(ui.host.querySelector(".login-fields").disabled, true);

  await act(async () => {
    button.click();
    ui.host.querySelector("form").requestSubmit();
    await Promise.resolve();
  });
  assert.equal(submissions.length, 1);
  await act(async () => { waits[0].resolve(); await waits[0].promise; });
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "로그인");

  id.value = "T01";
  password.value = "not-a-real-password";
  await act(async () => {
    password.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    ui.host.querySelector("form").requestSubmit();
    await Promise.resolve();
  });
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[1], ["T01", "not-a-real-password"]);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "로그인 중");
  await act(async () => { waits[1].resolve(); await waits[1].promise; });
});

test("login theme controls apply immediately and open the bundled manual in a new tab", async t => {
  const { LoginTheme } = load("src/app/(auth)/login/login-theme.tsx");
  const { MANUAL_PDF_PATH } = load("src/lib/manual.ts");
  const ui = await withDom(t, React.createElement(LoginTheme, { initialTheme: "light" }, "login"));
  const toggle = ui.host.querySelector('button[aria-label="다크모드로 변경"]');
  const manual = ui.host.querySelector('a[aria-label="사용자 매뉴얼 열기"]');
  assert.ok(manual);
  assert.equal(manual.target, "_blank");
  assert.equal(manual.rel, "noopener noreferrer");
  assert.equal(decodeURIComponent(new URL(manual.href).pathname),
    MANUAL_PDF_PATH);
  assert.equal(manual.hasAttribute("download"), false);
  const nextConfig = readFileSync("next.config.ts", "utf8");
  assert.match(nextConfig, /Content-Disposition", value: 'inline;/u);
  assert.equal(ui.host.querySelector(".auth-theme-shell").dataset.theme, "light");
  await act(async () => { toggle.click(); });
  assert.equal(ui.host.querySelector(".auth-theme-shell").dataset.theme, "dark");
  assert.match(ui.dom.window.document.cookie, /why-box-theme=dark/u);
  assert.ok(ui.host.querySelector('button[aria-label="라이트모드로 변경"]'));
  assert.match(readFileSync("src/app/app.css", "utf8"), /\.theme-toggle:hover:not\(:disabled\) \{\s*opacity: \.72/u);
});
