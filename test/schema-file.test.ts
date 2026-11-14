import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildNeoOrmSchema, renderNeoOrmSchema } from "../src/create-schema.js";
import {
	mergeAuthSchema,
	pickSchemaOutputPath,
	resolveSchemaOutputPath,
} from "../src/schema-file.js";

const parts = buildNeoOrmSchema({
	user: {
		modelName: "user",
		fields: {
			email: { type: "string", required: true, unique: true },
		},
	},
});

describe("pickSchemaOutputPath", () => {
	it("prefers the adapter schemaPath", () => {
		expect(
			pickSchemaOutputPath({
				schemaPath: "custom/auth.ts",
				configuredSchema: "./schema.ts",
				cliFile: "./db/schema.ts",
			}),
		).toBe("custom/auth.ts");
	});

	it("uses the NeoORM config schema before the CLI path", () => {
		expect(
			pickSchemaOutputPath({
				configuredSchema: "./schema.ts",
				cliFile: "./db/schema.ts",
			}),
		).toBe("./schema.ts");
	});

	it("uses the CLI path when no config schema is available", () => {
		expect(pickSchemaOutputPath({ cliFile: "./auth/schema.ts" })).toBe(
			"./auth/schema.ts",
		);
	});

	it("rejects a missing path", () => {
		expect(() => pickSchemaOutputPath({})).toThrow(/neoorm.config.ts/);
	});
});

describe("mergeAuthSchema", () => {
	const existing = `import { defineSchema, table, text, uuid } from "neoorm/schema";

export const schema = defineSchema(
	{
		posts: table({
			id: uuid().primary(),
			title: text().notNull(),
		}),
	},
	{ columnNaming: "camelCase" },
);
`;

	it("keeps existing tables and defineSchema options", () => {
		const merged = mergeAuthSchema(existing, parts);
		expect(merged).toContain("posts: table({");
		expect(merged).toContain('{ columnNaming: "camelCase" }');
		expect(merged).toContain("// better-auth:start");
		expect(merged).toContain("user: table({");
		expect(merged).toContain("email: text().notNull().unique(),");
		expect(merged).toContain("// better-auth:end");
		expect(merged.indexOf("posts:")).toBeLessThan(merged.indexOf("user:"));
	});

	it("adds missing neoorm/schema builders", () => {
		const merged = mergeAuthSchema(existing, parts);
		expect(merged).toMatch(
			/import \{[^}]*\btext\b[^}]*\} from "neoorm\/schema"/,
		);
		expect(merged).toMatch(
			/import \{[^}]*\buuid\b[^}]*\} from "neoorm\/schema"/,
		);
		expect(merged).toMatch(
			/import \{[^}]*\bdefineSchema\b[^}]*\} from "neoorm\/schema"/,
		);
	});

	it("replaces a previous auth region", () => {
		const first = mergeAuthSchema(existing, parts);
		const next = buildNeoOrmSchema({
			user: {
				modelName: "user",
				fields: {
					name: { type: "string", required: true },
				},
			},
		});
		const merged = mergeAuthSchema(first, next);
		expect(merged.match(/better-auth:start/g)).toHaveLength(1);
		expect(merged).toContain("name: text().notNull(),");
		expect(merged).not.toContain("email: text().notNull().unique(),");
		expect(merged).toContain("posts: table({");
		expect(merged).toContain('{ columnNaming: "camelCase" }');
	});

	it("renders a new file with a refreshable region", () => {
		const code = renderNeoOrmSchema(parts);
		expect(code).toContain("export const schema = defineSchema({");
		expect(code).toContain("// better-auth:start");
		expect(mergeAuthSchema(code, parts)).toBe(code);
	});
});

describe("resolveSchemaOutputPath", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			directories.splice(0).map((dir) => rm(dir, { recursive: true })),
		);
	});

	it("reads schema from neoorm.config.ts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neoorm-auth-"));
		directories.push(dir);
		await writeFile(
			join(dir, "neoorm.config.ts"),
			`export default {
				schema: "./app/schema.ts",
				out: "./neoorm",
				datasource: { provider: "sqlite", url: ":memory:" },
			};
			`,
		);
		await expect(
			resolveSchemaOutputPath({ cwd: dir, cliFile: "./db/schema.ts" }),
		).resolves.toBe("./app/schema.ts");
	});
});
