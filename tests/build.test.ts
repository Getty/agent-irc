// The Bun build scaffold (k6): the runtime pin and the committed bundle.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

// The schema ships with the getty-bun-integration skill, which skilletor
// installs untracked, so a clone and CI see only the copy in tests/fixtures.
// The subset of JSON Schema it uses (type, required, additionalProperties,
// const, pattern) is checked here; another keyword fails loudly.
const schemaPath = "tests/fixtures/getty-bun-requirement.schema.json";
const installedSchema = ".claude/skills/getty-bun-integration/assets/requirement.schema.json";

type Schema = {
  type: string;
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, { const?: unknown; type?: string; pattern?: string }>;
};

function violations(schema: Schema, value: unknown): string[] {
  const out: string[] = [];
  if (schema.type !== "object" || typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["not an object"];
  }
  const obj = value as Record<string, unknown>;
  for (const key of schema.required) if (!(key in obj)) out.push(`missing ${key}`);
  for (const [key, v] of Object.entries(obj)) {
    const rule = schema.properties[key];
    if (!rule) {
      if (schema.additionalProperties === false) out.push(`unexpected ${key}`);
      continue;
    }
    const known = new Set(["const", "type", "pattern", "description"]);
    for (const k of Object.keys(rule)) if (!known.has(k)) out.push(`schema keyword ${k} not checked`);
    if ("const" in rule && v !== rule.const) out.push(`${key} is not ${String(rule.const)}`);
    if (rule.type === "string" && typeof v !== "string") out.push(`${key} is not a string`);
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, "u").test(String(v))) {
      out.push(`${key} does not match ${rule.pattern}`);
    }
  }
  return out;
}

describe("package.json", () => {
  const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;

  test("gettyBun validates against the contract's requirement schema", () => {
    const schema = JSON.parse(read(schemaPath)) as Schema;
    expect(violations(schema, pkg.gettyBun)).toEqual([]);
  });

  test("gettyBun pins Bun 1.4.5, the pin of agent-bun-runtime 0.1.0", () => {
    expect(pkg.gettyBun).toEqual({ contractVersion: 1, bunVersion: "1.4.5" });
  });

  test("the schema check rejects a malformed pin", () => {
    const schema = JSON.parse(read(schemaPath)) as Schema;
    expect(violations(schema, { contractVersion: 2, bunVersion: "v1.4" })).toHaveLength(2);
  });

  test.skipIf(!existsSync(join(root, installedSchema)))(
    "the schema copy equals the one in the installed getty-bun-integration skill",
    () => {
      expect(read(schemaPath)).toBe(read(installedSchema));
    },
  );

  test("carries no version and no runtime dependency", () => {
    expect(pkg.version).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe("dist/server.js", () => {
  test("starts with the // @bun pragma, so Bun writes no transpiler cache", () => {
    expect(read("dist/server.js").split("\n", 1)[0]).toBe("// @bun");
  });

  test("embeds no absolute path of the machine that built it", () => {
    const bundle = read("dist/server.js");
    expect(bundle).not.toContain(root);
    expect(bundle).not.toMatch(/\/home\/|\/tmp\/|\/Users\//);
  });
});

// The getty-bun starters are copies of the getty-bun-install render
// (agent-bun-runtime v0.1.0, vars.bun_version 1.4.5): never edited here.
describe("bootstrap/", () => {
  const rendered = ".claude/skills/getty-bun-install/bootstrap";

  for (const name of ["getty-bun.sh", "getty-bun.ps1"]) {
    test.skipIf(!existsSync(join(root, rendered, name)))(`${name} equals the rendered starter byte for byte`, () => {
      expect(readFileSync(join(root, "bootstrap", name)).equals(readFileSync(join(root, rendered, name)))).toBe(true);
    });

    test(`${name} is LF only and not executable, as cp -p of the render leaves it`, () => {
      expect(read(`bootstrap/${name}`)).not.toContain("\r");
      expect(statSync(join(root, "bootstrap", name)).mode & 0o111).toBe(0);
    });
  }

  test("both starters pin the Bun of package.json", () => {
    const pin = (JSON.parse(read("package.json")) as { gettyBun: { bunVersion: string } }).gettyBun.bunVersion;
    expect(read("bootstrap/getty-bun.sh").split("\n")).toContain(`# version ${pin}`);
    expect(read("bootstrap/getty-bun.ps1").split(/\r?\n/)).toContain(`# version ${pin}`);
  });
});
