import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "neoorm";
import {
	AUTH_REGION_END,
	AUTH_REGION_START,
	type NeoOrmSchemaParts,
} from "./create-schema.js";

const MISSING_PATH =
	"[neoorm-better-auth-adapter] No schema path found. Set `schema` in neoorm.config.ts, or pass `schemaPath` to neoormAdapter.";

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Choose where Better Auth should write the NeoORM schema.
 *
 * An explicit adapter path wins, then `schema` from `defineConfig`, then the
 * path the CLI passed in.
 */
export function pickSchemaOutputPath(input: {
	schemaPath?: string | undefined;
	configuredSchema?: string | undefined;
	cliFile?: string | undefined;
}): string {
	const explicit = nonempty(input.schemaPath);
	if (explicit) return explicit;
	const configured = nonempty(input.configuredSchema);
	if (configured) return configured;
	const cliFile = nonempty(input.cliFile);
	if (cliFile) return cliFile;
	throw new Error(MISSING_PATH);
}

/**
 * Resolve the schema path for the project in `cwd`.
 *
 * Reads `neoorm.config.ts` when it is present. A broken config is reported
 * instead of being skipped.
 */
export async function resolveSchemaOutputPath(input: {
	schemaPath?: string | undefined;
	cliFile?: string | undefined;
	cwd?: string | undefined;
}): Promise<string> {
	const explicit = nonempty(input.schemaPath);
	if (explicit) return explicit;
	const cwd = input.cwd ?? process.cwd();
	let configuredSchema: string | undefined;
	if (existsSync(join(cwd, "neoorm.config.ts"))) {
		const config = await loadConfig(cwd);
		configuredSchema = config.schema;
	}
	return pickSchemaOutputPath({
		cliFile: input.cliFile,
		configuredSchema,
	});
}

function skipString(source: string, index: number): number {
	const quote = source[index];
	let i = index + 1;
	if (quote === "`") {
		while (i < source.length) {
			if (source[i] === "\\") {
				i += 2;
				continue;
			}
			if (source[i] === "$" && source[i + 1] === "{") {
				i = matchBrace(source, i + 1) + 1;
				continue;
			}
			if (source[i] === "`") return i + 1;
			i++;
		}
		return i;
	}
	while (i < source.length) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === quote) return i + 1;
		i++;
	}
	return i;
}

function skipTrivia(source: string, index: number): number {
	let i = index;
	while (i < source.length) {
		if (/\s/.test(source[i] ?? "")) {
			i++;
			continue;
		}
		if (source[i] === "/" && source[i + 1] === "/") {
			const newline = source.indexOf("\n", i);
			i = newline === -1 ? source.length : newline + 1;
			continue;
		}
		if (source[i] === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}

function matchBrace(source: string, open: number): number {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === "'" || char === '"' || char === "`") {
			i = skipString(source, i) - 1;
			continue;
		}
		if (char === "/" && source[i + 1] === "/") {
			const newline = source.indexOf("\n", i);
			i = newline === -1 ? source.length : newline;
			continue;
		}
		if (char === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	throw new Error(
		"[neoorm-better-auth-adapter] The schema file has an unclosed `defineSchema` object.",
	);
}

function findDefineSchemaOpen(source: string): number {
	const key = "defineSchema";
	let from = 0;
	while (from < source.length) {
		const at = source.indexOf(key, from);
		if (at === -1) break;
		const before = source[at - 1];
		if (before !== undefined && /[A-Za-z0-9_$]/.test(before)) {
			from = at + key.length;
			continue;
		}
		let i = skipTrivia(source, at + key.length);
		if (source[i] !== "(") {
			from = at + key.length;
			continue;
		}
		i = skipTrivia(source, i + 1);
		if (source[i] !== "{") {
			throw new Error(
				"[neoorm-better-auth-adapter] `defineSchema` must be called with an object literal so Better Auth tables can be merged into it.",
			);
		}
		return i;
	}
	throw new Error(
		"[neoorm-better-auth-adapter] The schema file has no `defineSchema({ ... })` call to update.",
	);
}

function needsTrailingComma(beforeClose: string): boolean {
	let text = beforeClose.replace(/\s+$/, "");
	while (text.length > 0) {
		const lineStart = text.lastIndexOf("\n") + 1;
		const line = text.slice(lineStart);
		if (!line.trimStart().startsWith("//")) break;
		text = text.slice(0, lineStart).replace(/\s+$/, "");
	}
	if (text.endsWith("*/")) {
		const start = text.lastIndexOf("/*");
		if (start !== -1) text = text.slice(0, start).replace(/\s+$/, "");
	}
	if (text.length === 0) return false;
	const last = text[text.length - 1];
	return last !== "{" && last !== ",";
}

function importNames(body: string): string[] {
	return body
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

function mergeSchemaImport(source: string, needed: string[]): string {
	const match = /import\s*\{([^}]*)\}\s*from\s*["']neoorm\/schema["']/.exec(
		source,
	);
	if (!match || match.index === undefined) {
		const line = `import { ${[...needed].sort().join(", ")} } from "neoorm/schema";\n`;
		return line + source;
	}
	const existing = importNames(match[1] ?? "");
	const have = new Set(existing);
	const missing = [...needed].filter((name) => !have.has(name)).sort();
	if (missing.length === 0) return source;
	const names = [...existing, ...missing];
	const original = match[0];
	const multiline = original.includes("\n");
	const replacement = multiline
		? `import {\n${names.map((name) => `\t${name},`).join("\n")}\n} from "neoorm/schema"`
		: `import { ${names.join(", ")} } from "neoorm/schema"`;
	return (
		source.slice(0, match.index) +
		replacement +
		source.slice(match.index + original.length)
	);
}

function replaceAuthRegion(source: string, tables: string): string | undefined {
	const start = source.indexOf(AUTH_REGION_START);
	const end = source.indexOf(AUTH_REGION_END);
	if (start === -1 && end === -1) return undefined;
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			"[neoorm-better-auth-adapter] The schema file has an incomplete better-auth region. It needs both `// better-auth:start` and `// better-auth:end`.",
		);
	}
	const lineBreak = source.indexOf("\n", start);
	const afterStart =
		lineBreak === -1 ? start + AUTH_REGION_START.length : lineBreak + 1;
	const body = tables.length > 0 ? `${tables}\n` : "";
	return source.slice(0, afterStart) + body + source.slice(end);
}

/**
 * Insert or replace the Better Auth tables in an existing schema module.
 *
 * Other tables and the `defineSchema` options argument are left in place.
 * The `neoorm/schema` import gains any builders the auth tables need.
 */
export function mergeAuthSchema(
	existing: string,
	parts: NeoOrmSchemaParts,
): string {
	const withImport = mergeSchemaImport(existing, parts.imports);
	const replaced = replaceAuthRegion(withImport, parts.tables);
	if (replaced !== undefined) return replaced;

	const open = findDefineSchemaOpen(withImport);
	const close = matchBrace(withImport, open);
	const comma = needsTrailingComma(withImport.slice(0, close)) ? "," : "";
	const body = parts.tables.length > 0 ? `\n${parts.tables}\n` : "\n";
	const block = `${comma}\n${AUTH_REGION_START}${body}${AUTH_REGION_END}\n`;
	return withImport.slice(0, close) + block + withImport.slice(close);
}
