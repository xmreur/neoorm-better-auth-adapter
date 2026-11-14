import type {
	BetterAuthDBSchema,
	DBFieldAttribute,
} from "@better-auth/core/db";

/** Options for {@link generateNeoOrmSchema}. */
export type NeoOrmSchemaCodegenOptions = {
	/**
	 * Resolve the NeoORM accessor / table name for a Better Auth model key.
	 *
	 * @default (model) => model
	 */
	modelName?: ((model: string) => string) | undefined;
	/**
	 * Resolve the NeoORM column name for a Better Auth field.
	 *
	 * @default (_model, field) => field
	 */
	fieldName?: ((model: string, field: string) => string) | undefined;
};

/** Marks the Better Auth tables inside an existing `defineSchema` call. */
export const AUTH_REGION_START = "// better-auth:start";
/** End of the region opened by {@link AUTH_REGION_START}. */
export const AUTH_REGION_END = "// better-auth:end";

/** Table entries and the `neoorm/schema` builders they use. */
export type NeoOrmSchemaParts = {
	imports: string[];
	/** Indented `defineSchema` entries, one table per block. */
	tables: string;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function stringLiteral(value: string): string {
	return JSON.stringify(value);
}

function defaultValueExpression(field: DBFieldAttribute): string | undefined {
	const { defaultValue } = field;
	if (defaultValue === undefined) return undefined;

	// Never call `defaultValue()`: Better Auth may use it as a stateful
	// counter, and generating a schema must not have side effects.
	if (typeof defaultValue === "function") {
		return field.type === "date" ? "defaultNow()" : undefined;
	}
	if (defaultValue === null) return undefined;
	if (
		typeof defaultValue === "string" ||
		typeof defaultValue === "number" ||
		typeof defaultValue === "boolean"
	) {
		return `default(${JSON.stringify(defaultValue)})`;
	}
	return undefined;
}

/**
 * NeoORM derives a relation name by stripping a trailing `Id`. A column that
 * does not end in `Id` (for example `one_to_one`) would otherwise share its
 * name with the relation, and every filter on that column is compiled as a
 * relation filter.
 */
function relationNameFor(column: string): string {
	const stripped = column.replace(/_(?:Id|id)$/, "").replace(/Id$/, "");
	if (stripped.length > 0 && stripped !== column) return stripped;
	return `${column}Rel`;
}

function baseBuilder(
	field: DBFieldAttribute,
	names: {
		modelName: (model: string) => string;
		fieldName: (model: string, field: string) => string;
		/** Accessor of the table that owns this column. */
		table: string;
		/** TypeScript name of this column. */
		column: string;
	},
): string {
	if (field.references) {
		const targetTable = names.modelName(field.references.model);
		const targetColumn = names.fieldName(
			field.references.model,
			field.references.field,
		);
		const relation = relationNameFor(names.column);
		// Inverse names live on the referenced table and must be unique there,
		// including when several tables point at it through the same column name.
		const inverse = `${names.table}_${relation}`;
		const target = stringLiteral(`${targetTable}.${targetColumn}`);
		return `fk(${target}).as(${stringLiteral(relation)}).inverse(${stringLiteral(inverse)})`;
	}
	switch (field.type) {
		case "number":
			return field.bigint ? "bigint()" : "int()";
		case "boolean":
			return "bool()";
		case "date":
			return "timestamp()";
		case "json":
			return "jsonb()";
		case "string[]":
			return "textArray()";
		case "number[]":
			return "intArray()";
		default:
			return "text()";
	}
}

function columnExpression(
	field: DBFieldAttribute,
	options: {
		isId: boolean;
		modelName: (model: string) => string;
		fieldName: (model: string, field: string) => string;
		table: string;
		column: string;
	},
): { expression: string; imports: string[] } {
	const imports = new Set<string>();
	const base = baseBuilder(field, options);
	imports.add(/^(\w+)/.exec(base)?.[1] ?? "text");

	const chain: string[] = [];
	if (options.isId) chain.push("primary()");
	if (field.required !== false) chain.push("notNull()");
	if (field.unique) chain.push("unique()");
	if (field.index) chain.push("index()");

	const defaultValue = defaultValueExpression(field);
	if (defaultValue) chain.push(defaultValue);

	// Match the Drizzle adapter: unspecified deletes cascade, so removing a
	// parent row removes dependents. NeoORM has no "set default" action.
	if (field.references) {
		const onDelete = field.references.onDelete ?? "cascade";
		if (onDelete !== "set default") {
			chain.push(`onDelete(${stringLiteral(onDelete)})`);
		}
	}

	const expression = chain.length === 0 ? base : `${base}.${chain.join(".")}`;
	return { expression, imports: [...imports] };
}

/**
 * Build the Better Auth tables and the NeoORM builders they import.
 *
 * The table text is meant to sit inside an existing `defineSchema({ ... })`.
 */
export function buildNeoOrmSchema(
	tables: BetterAuthDBSchema,
	options: NeoOrmSchemaCodegenOptions = {},
): NeoOrmSchemaParts {
	const accessorByModel = new Map<string, string>();
	for (const [key, definition] of Object.entries(tables)) {
		accessorByModel.set(
			key,
			options.modelName?.(key) ??
				(definition.modelName && definition.modelName.length > 0
					? definition.modelName
					: key),
		);
	}
	const modelName = (model: string) => accessorByModel.get(model) ?? model;
	const fieldName =
		options.fieldName ??
		((model: string, field: string) =>
			tables[model]?.fields[field]?.fieldName ?? field);

	const imports = new Set<string>(["defineSchema", "table"]);
	const tableBlocks: string[] = [];

	for (const [model, definition] of Object.entries(tables)) {
		if (definition.disableMigrations) continue;

		const accessor = modelName(model);
		const columns: string[] = [
			// Better Auth adds the `id` field at adapter-transform time, so it is
			// absent from `getAuthTables()`.
			`\t\t${propertyKey(fieldName(model, "id"))}: text().primary(),`,
		];
		imports.add("text");

		for (const [field, attribute] of Object.entries(definition.fields)) {
			const column = fieldName(model, field);
			const { expression, imports: used } = columnExpression(attribute, {
				isId: field === "id",
				modelName,
				fieldName,
				table: accessor,
				column,
			});
			for (const entry of used) imports.add(entry);
			columns.push(`\t\t${propertyKey(column)}: ${expression},`);
		}

		const columnBlock = columns.join("\n");
		const indexes = definition.indexes ?? [];
		if (indexes.length === 0) {
			tableBlocks.push(
				`\t${propertyKey(accessor)}: table({\n${columnBlock}\n\t}),`,
			);
			continue;
		}

		const extras = indexes.map((index) => {
			const helper = index.unique ? "unique" : "index";
			const keys = index.fields
				.map((entry) => stringLiteral(fieldName(model, entry)))
				.join(", ");
			return `t.${helper}(${keys})`;
		});
		tableBlocks.push(
			`\t${propertyKey(accessor)}: table({\n${columnBlock}\n\t}, (t) => [${extras.join(", ")}]),`,
		);
	}

	return { imports: [...imports].sort(), tables: tableBlocks.join("\n") };
}

/**
 * Render {@link buildNeoOrmSchema} as a new schema module.
 *
 * The auth tables sit between {@link AUTH_REGION_START} and
 * {@link AUTH_REGION_END} so a later generate can refresh them in place.
 */
export function renderNeoOrmSchema(parts: NeoOrmSchemaParts): string {
	const importList = parts.imports.join(", ");
	return `// Generated by neoorm-better-auth-adapter. Re-run \`npx @better-auth/cli generate\` to update.
import { ${importList} } from "neoorm/schema";

export const schema = defineSchema({
${AUTH_REGION_START}
${parts.tables}
${AUTH_REGION_END}
});
`;
}

/**
 * Generate a NeoORM `schema.ts` from Better Auth's table definitions.
 *
 * The output is a self-contained module that can be imported by
 * `neoorm generate` / `neoorm migrate`.
 */
export function generateNeoOrmSchema(
	tables: BetterAuthDBSchema,
	options: NeoOrmSchemaCodegenOptions = {},
): string {
	return renderNeoOrmSchema(buildNeoOrmSchema(tables, options));
}
