import fs from "fs";
import path from "path";
import type {
  JscTarget,
  JsMinifyOptions,
  Options as SWCOptions,
} from "@swc/core";
import { transform } from "@swc/core";
import type { PluginOption } from "vite";

const runtimePublicPath = "/@react-refresh";
const refreshLoadCode = `import{injectIntoGlobalHook}from"${runtimePublicPath}";injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;`;

let define: { [key: string]: string } | undefined;

type Options = {
  /**
   * @default true
   */
  minify?: boolean;
  /**
   * @default true
   */
  build?: boolean;
  /**
   * @default true
   */
  serve?: boolean;
  /**
   * @default true
   */
  refresh?: boolean;
  /**
   * @default "automatic"
   */
  runtime?: "automatic" | "classic";
  /**
   * @default tsconfig.compilerOptions.target OR es2020
   */
  target?: JscTarget;
  /**
   * @default vite's config.build.sourcemap
   */
  sourcemap?: boolean;
  /**
   * @default { minify: { toplevel: false }, mangle: true }
   */
  minifyOptions?: JsMinifyOptions;
} & SWCOptions;

const tsConfigCache: any = {};
const appDirectory = fs.realpathSync(process.cwd());
const getTsConfigOptions = async (mode: "build" | "serve" | "minify") => {
  if (!tsConfigCache[mode]) {
    let file = path.resolve(appDirectory, "tsconfig.json");
    if (!fs.existsSync(file)) {
      file = path.resolve(appDirectory, "jsconfig.json");
      if (!fs.existsSync(file)) {
        return Promise.resolve({});
      }
    }
    tsConfigCache[mode] = await import(file);
  }

  return Promise.resolve(tsConfigCache[mode]);
};

export const serve: (options: Options) => PluginOption = ({
  minify,
  build,
  serve = true,
  refresh = true,
  runtime = "automatic",
  target,
  sourcemap,
  minifyOptions,
  ...swcOptions
}: Options = {}) => {
  if (build || minify)
    throw new Error(
      "cannot use minify or build in serve plugin, use plugins separately or use the all helper",
    );
  if (!serve) return null;

  let refreshStuffLoad: Partial<PluginOption> = {};
  if (refresh) {
    refreshStuffLoad = {
      resolveId: (id) => (id === runtimePublicPath ? id : undefined),
      load: (id) =>
        id === runtimePublicPath
          ? fs.readFileSync(
              path.join(__dirname, "react-refresh-runtime.js"),
              "utf-8",
            )
          : undefined,
      transformIndexHtml: () => [
        { tag: "script", attrs: { type: "module" }, children: refreshLoadCode },
      ],
    };
  }

  return {
    name: "swc-serve",
    apply: "serve",
    config: (config) => {
      if (config.esbuild) define = config.esbuild.define;
      config.esbuild = false;
      tsConfigCache["serve"] = undefined;
    },
    ...refreshStuffLoad,
    async transform(code, id) {
      if (id.includes("node_modules")) return;
      const ext = id.substring(id.length - 3);
      if (!(ext === ".js" || ext === ".ts" || ext === "jsx" || ext === "tsx"))
        return;

      const isTS = ext === ".ts" || ext === "tsx";
      const isJSX = ext === "jsx" || ext === "tsx";

      const tsconfig = await getTsConfigOptions("serve");

      const result = await transform(code, {
        filename: id,
        swcrc: false,
        configFile: false,
        ...swcOptions,
        jsc: {
          target:
            typeof target !== "undefined"
              ? target
              : tsconfig?.compilerOptions?.target || "es2020",
          keepClassNames: !!tsconfig?.compilerOptions?.experimentalDecorators,
          ...swcOptions?.jsc,
          parser: {
            syntax: isTS ? "typescript" : "ecmascript",
            [isTS ? "tsx" : "jsx"]: isJSX,
            decorators: !!tsconfig?.compilerOptions?.experimentalDecorators,
            dynamicImport: true,
            ...swcOptions?.jsc?.parser,
          },
          transform: {
            legacyDecorator:
              !!tsconfig?.compilerOptions?.experimentalDecorators,
            decoratorMetadata: !!tsconfig?.compilerOptions
              ?.experimentalDecorators
              ? tsconfig?.compilerOptions?.emitDecoratorMetadata
              : undefined,
            ...swcOptions?.jsc?.transform,
            react: {
              runtime: runtime,
              pragma: tsconfig?.compilerOptions?.jsxFactory,
              pragmaFrag: tsconfig?.compilerOptions?.jsxFragmentFactory,
              importSource: tsconfig?.compilerOptions?.jsxImportSource,
              refresh: refresh,
              useBuiltins: refresh,
              ...swcOptions?.jsc?.transform?.react,
              development: true,
            },
            optimizer: {
              ...swcOptions?.jsc?.transform?.optimizer,
              globals: {
                ...swcOptions?.jsc?.transform?.optimizer?.globals,
                vars: {
                  ...define,
                  ...swcOptions?.jsc?.transform?.optimizer?.globals?.vars,
                },
              },
            },
          },
        },
      });

      if (!refresh) return result;
      if (!result.code.includes("$RefreshReg$")) return result;

      const header = `import * as RefreshRuntime from "${runtimePublicPath}";let prevRefreshReg;let prevRefreshSig;if(!window.$RefreshReg$)throw new Error("React refresh preamble was not loaded!");prevRefreshReg=window.$RefreshReg$;prevRefreshSig=window.$RefreshSig$;window.$RefreshReg$=RefreshRuntime.getRefreshReg("${id}");window.$RefreshSig$=RefreshRuntime.createSignatureFunctionForTransform;`;
      const footer = `;window.$RefreshReg$=prevRefreshReg;window.$RefreshSig$=prevRefreshSig;import.meta.hot.accept();RefreshRuntime.enqueueUpdate();`;

      return { code: `${header}${result.code}${footer}`, map: result.map };
    },
  };
};

export const build: (options: Options) => PluginOption = ({
  minify,
  build = true,
  serve,
  refresh = true,
  runtime = "automatic",
  target,
  sourcemap,
  minifyOptions,
  ...swcOptions
}: Options = {}) => {
  if (serve || minify)
    throw new Error(
      "cannot use minify or serve in build plugin, use plugins separately or use the all helper",
    );
  if (!build) return null;

  let targets: any = undefined;
  let hasBrowserList = false;

  return {
    name: "swc-build",
    apply: "build",
    config: (config) => {
      if (config.esbuild) define = config.esbuild.define;
      config.esbuild = false;
      targets = config.build?.target;
      tsConfigCache["build"] = undefined;

      try {
        require("browserlist");
        hasBrowserList = true;
      } catch (e) {
        hasBrowserList = false;
        if (swcOptions?.env) {
          console.error('"browserlist" is not installed!');
          process.exit(1);
        }
      }
    },
    async transform(code, id) {
      if (id.includes("node_modules")) return;
      const ext = id.substring(id.length - 3);
      if (!(ext === ".js" || ext === ".ts" || ext === "jsx" || ext === "tsx"))
        return;

      const isTS = ext === ".ts" || ext === "tsx";
      const isJSX = ext === "jsx" || ext === "tsx";

      const tsconfig = await getTsConfigOptions("build");

      return await transform(code, {
        filename: id,
        swcrc: false,
        configFile: false,
        env: hasBrowserList
          ? {
              targets:
                targets === "modules"
                  ? ["es2019", "edge88", "firefox78", "chrome87", "safari13.1"]
                  : targets,
              mode: "usage",
              coreJs: "3",
              dynamicImport: true,
              ...swcOptions?.env,
            }
          : undefined,
        ...swcOptions,
        // always needs sourcemap in transform build to map back
        sourceMaps: true,
        jsc: {
          target:
            typeof target !== "undefined"
              ? target
              : tsconfig?.compilerOptions?.target || "es2020",
          keepClassNames: !!tsconfig?.compilerOptions?.experimentalDecorators,
          ...swcOptions?.jsc,
          parser: {
            syntax: isTS ? "typescript" : "ecmascript",
            [isTS ? "tsx" : "jsx"]: isJSX,
            decorators: !!tsconfig?.compilerOptions?.experimentalDecorators,
            dynamicImport: true,
            ...swcOptions?.jsc?.parser,
          },
          transform: {
            legacyDecorator:
              !!tsconfig?.compilerOptions?.experimentalDecorators,
            decoratorMetadata: !!tsconfig?.compilerOptions
              ?.experimentalDecorators
              ? tsconfig?.compilerOptions?.emitDecoratorMetadata
              : undefined,
            ...swcOptions?.jsc?.transform,
            react: {
              runtime: runtime,
              pragma: tsconfig?.compilerOptions?.jsxFactory,
              pragmaFrag: tsconfig?.compilerOptions?.jsxFragmentFactory,
              importSource: tsconfig?.compilerOptions?.jsxImportSource,
              ...swcOptions?.jsc?.transform?.react,
            },
            optimizer: {
              ...swcOptions?.jsc?.transform?.optimizer,
              globals: {
                ...swcOptions?.jsc?.transform?.optimizer?.globals,
                vars: {
                  ...define,
                  ...swcOptions?.jsc?.transform?.optimizer?.globals?.vars,
                },
              },
            },
          },
        },
      });
    },
  };
};

export const minify: (options: Options) => PluginOption = ({
  minify = true,
  build,
  serve,
  refresh = true,
  runtime = "automatic",
  target,
  sourcemap,
  minifyOptions,
  ...swcOptions
}: Options = {}) => {
  if (serve || build)
    throw new Error(
      "cannot use build or serve in minify plugin, use plugins separately or use the all helper",
    );
  if (!minify) return null;
  let sourcemaps = true;
  return {
    name: "swc-minify",
    apply: "build",
    enforce: "post",
    config: (config) => {
      if (!config.build) config.build = {};
      config.build.minify = false;
      sourcemaps = !!config.build.sourcemap;
      tsConfigCache["minify"] = undefined;
    },
    async renderChunk(code, chunk) {
      const tsconfig = await getTsConfigOptions("minify");

      return await transform(code, {
        sourceMaps: typeof sourcemap !== "undefined" ? sourcemap : sourcemaps,
        swcrc: false,
        configFile: false,
        ...swcOptions,
        filename: chunk.fileName,
        // minify is always on if we got here
        minify: true,
        jsc: {
          minify: {
            compress:
              minifyOptions?.compress === false
                ? false
                : {
                    toplevel: false,
                    ...(typeof minifyOptions?.compress === "object"
                      ? minifyOptions?.compress
                      : {}),
                  },
            mangle: true,
            ...minifyOptions,
          },
          target:
            typeof target !== "undefined"
              ? target
              : tsconfig?.compilerOptions?.target || "es2020",
          ...swcOptions?.jsc,
        },
      });
    },
  };
};

function swcPluginsFactory({
  minify: m = true,
  build: b = true,
  serve: s = true,
  ...options
}: Options = {}): PluginOption[] {
  return [s && serve(options), b && build(options), m && minify(options)];
}

swcPluginsFactory.serve = serve;
swcPluginsFactory.build = build;
swcPluginsFactory.minify = minify;

export default swcPluginsFactory;
