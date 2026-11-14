import { testAdapter } from "@better-auth/test-utils/adapter";
import { afterAll } from "vitest";
import { neoormAdapter } from "../src/index.js";
import { adapterTestSuites } from "./suites.js";
import { createTestDatabase } from "./support.js";

const db = createTestDatabase();

const { execute } = await testAdapter({
	adapter: () =>
		neoormAdapter(() => db.getClient(), {
			transaction: true,
			// The official suites rebuild the schema between groups, so the
			// client has to be resolved lazily.
		}),
	runMigrations: db.runMigrations,
	tests: adapterTestSuites(),
	onFinish: db.close,
});

execute();

afterAll(() => db.close());
