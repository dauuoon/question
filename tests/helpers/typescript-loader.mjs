import {readFileSync,existsSync} from "node:fs";
import {createRequire} from "node:module";
import {runInThisContext} from "node:vm";
import ts from "typescript";
import {URL} from "node:url";

const require=createRequire(import.meta.url);
export function typescriptLoader(overrides={}) {
  const cache=new Map();
  function load(path) {
    let url=path instanceof URL?path:new URL(`../../${path}`,import.meta.url);
    if(!existsSync(url)&&url.pathname.endsWith(".ts"))url=new URL(`${url.href}x`);
    if(cache.has(url.href))return cache.get(url.href);
    const compiled=ts.transpileModule(readFileSync(url,"utf8"),{compilerOptions:{
      module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
    }}).outputText;
    const module={exports:{}};cache.set(url.href,module.exports);
    runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
      name=>Object.hasOwn(overrides,name)?overrides[name]:name==="server-only"?{}:
        name.startsWith("@/")?load(`src/${name.slice(2)}.ts`):
          name.startsWith(".")?load(new URL(`${name}.ts`,url)):require(name),module,module.exports);
    cache.set(url.href,module.exports);
    return module.exports;
  }
  return load;
}
