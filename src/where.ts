import type { CleanedWhere } from "@better-auth/core/db/adapter";

/**
 * A NeoORM `where` object.
 *
 * NeoORM accepts scalar equality (`{ email: "a@b.com" }`) and operator objects
 * (`{ email: { contains: "@b.com" } }`), combined with `AND` / `OR` / `NOT`.
 */
export type NeoOrmWhere = Record<string, unknown>;

/** Equality filter, including `null` and case-insensitive comparisons. */
function equalityNode(value: unknown, insensitive: boolean): unknown {
	if (value === null) return { isNull: true };
	if (insensitive && typeof value === "string") {
		return { equals: value, mode: "insensitive" };
	}
	return { equals: value };
}

function isInsensitive(w: CleanedWhere): boolean {
	return w.mode === "insensitive" && typeof w.value === "string";
}

function asArray(w: CleanedWhere): unknown[] {
	if (!Array.isArray(w.value)) {
		throw new TypeError(
			`[neoorm-better-auth-adapter] The "${w.operator}" operator requires an array value for field "${w.field}".`,
		);
	}
	return w.value;
}

/**
 * Convert a single Better Auth condition into a NeoORM where node.
 */
export function convertCondition(w: CleanedWhere): NeoOrmWhere {
	const { field, operator = "eq", value } = w;

	switch (operator) {
		case "eq":
			return { [field]: equalityNode(value, isInsensitive(w)) };
		case "ne":
			if (value === null) return { [field]: { isNotNull: true } };
			return { NOT: { [field]: equalityNode(value, isInsensitive(w)) } };
		case "lt":
			return { [field]: { lt: value } };
		case "lte":
			return { [field]: { lte: value } };
		case "gt":
			return { [field]: { gt: value } };
		case "gte":
			return { [field]: { gte: value } };
		case "contains":
			return {
				[field]: isInsensitive(w)
					? { contains: value, mode: "insensitive" }
					: { contains: value },
			};
		case "starts_with":
			return {
				[field]: isInsensitive(w)
					? { startsWith: value, mode: "insensitive" }
					: { startsWith: value },
			};
		case "ends_with":
			return {
				[field]: isInsensitive(w)
					? { endsWith: value, mode: "insensitive" }
					: { endsWith: value },
			};
		case "in": {
			const values = asArray(w);
			if (w.mode !== "insensitive") return { [field]: { in: values } };
			// NeoORM ignores `mode` for `in` / `notIn`, so emulate a
			// case-insensitive membership test with an OR of equalities.
			return {
				OR: values.map((entry) => ({
					[field]: equalityNode(entry, true),
				})),
			};
		}
		case "not_in": {
			const values = asArray(w);
			if (w.mode !== "insensitive") return { [field]: { notIn: values } };
			return {
				NOT: {
					OR: values.map((entry) => ({
						[field]: equalityNode(entry, true),
					})),
				},
			};
		}
		default: {
			const exhaustive: never = operator;
			throw new TypeError(
				`[neoorm-better-auth-adapter] Unsupported operator "${String(exhaustive)}" for field "${field}".`,
			);
		}
	}
}

/**
 * Convert a Better Auth where clause into a NeoORM `where` object.
 *
 * Better Auth emits a flat list of conditions, each tagged `AND` or `OR`.
 * Connector semantics mirror Drizzle: every `AND` condition is combined, every
 * `OR` condition is combined, then both groups are AND-ed together.
 */
export function convertWhere(
	where: CleanedWhere[] | undefined,
): NeoOrmWhere | undefined {
	if (!where || where.length === 0) return undefined;

	const andGroup: NeoOrmWhere[] = [];
	const orGroup: NeoOrmWhere[] = [];

	for (const condition of where) {
		const node = convertCondition(condition);
		if (condition.connector === "OR") orGroup.push(node);
		else andGroup.push(node);
	}

	if (andGroup.length > 0 && orGroup.length > 0) {
		return {
			AND: [
				andGroup.length === 1 ? andGroup[0] : { AND: andGroup },
				orGroup.length === 1 ? orGroup[0] : { OR: orGroup },
			],
		};
	}
	if (orGroup.length > 0) {
		return orGroup.length === 1 ? orGroup[0] : { OR: orGroup };
	}
	return andGroup.length === 1 ? andGroup[0] : { AND: andGroup };
}
