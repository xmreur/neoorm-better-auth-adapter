import {
	authFlowTestSuite,
	caseInsensitiveTestSuite,
	joinsTestSuite,
	normalTestSuite,
	transactionsTestSuite,
} from "@better-auth/test-utils/adapter";

/** Official Better Auth adapter suites supported by this adapter. */
export function adapterTestSuites() {
	return [
		normalTestSuite(),
		joinsTestSuite(),
		caseInsensitiveTestSuite(),
		transactionsTestSuite(),
		authFlowTestSuite(),
	];
}
