import { testAdapter } from "@better-auth/test-utils/adapter";
import { afterAll } from "vitest";
import { neoormAdapter } from "../src/index.js";
import { adapterTestSuites } from "./suites.js";
import { createTestDatabase } from "./support.js";

const db = createTestDatabase({ usePlural: true });

const { execute } = await testAdapter({
	adapter: () =>
		neoormAdapter(() => db.getClient(), {
			usePlural: true,
			transaction: true,
		}),
	runMigrations: db.runMigrations,
	tests: adapterTestSuites(),
	onFinish: db.close,
});

execute();

afterAll(() => db.close());
