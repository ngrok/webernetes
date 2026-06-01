import { expect, it } from "vitest";
import { browser } from "../../../../test/describe";
import { Aggregate, flatten, newAggregate } from "./errors";

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestEmptyAggregate.
browser.describe("emptyAggregate", () => {
	it("returns undefined for an empty list", () => {
		const slice: Error[] = [];

		const agg = newAggregate(slice);
		expect(agg).toBeUndefined();

		const err: Error | undefined = newAggregate(slice);
		expect(err).toBeUndefined();
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestAggregateWithNil.
browser.describe("aggregateWithNil", () => {
	it("drops undefined errors", () => {
		const slice: Array<Error | undefined> = [undefined];

		let agg = newAggregate(slice);
		expect(agg).toBeUndefined();

		slice.push(new Error("err"));
		agg = newAggregate(slice);
		expect(agg).toBeInstanceOf(Aggregate);
		expect(agg?.message).toBe("err");
		expect(agg?.errors).toHaveLength(1);
		expect(agg?.errors[0]?.message).toBe("err");

		const err: Error | undefined = agg;
		expect(err).toBeDefined();
		expect(err?.message).toBe("err");
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestSingularAggregate.
browser.describe("singularAggregate", () => {
	it("returns a singular aggregate message", () => {
		const slice = [new Error("err")];

		const agg = newAggregate(slice);
		expect(agg).toBeInstanceOf(Aggregate);
		expect(agg?.message).toBe("err");
		expect(agg?.errors).toHaveLength(1);
		expect(agg?.errors[0]?.message).toBe("err");

		const err: Error | undefined = agg;
		expect(err).toBeDefined();
		expect(err?.message).toBe("err");
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestPluralAggregate.
browser.describe("pluralAggregate", () => {
	it("returns a bracketed plural aggregate message", () => {
		const slice = [new Error("abc"), new Error("123")];

		const agg = newAggregate(slice);
		expect(agg).toBeInstanceOf(Aggregate);
		expect(agg?.message).toBe("[abc, 123]");
		expect(agg?.errors).toHaveLength(2);
		expect(agg?.errors[0]?.message).toBe("abc");

		const err: Error | undefined = agg;
		expect(err).toBeDefined();
		expect(err?.message).toBe("[abc, 123]");
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestDedupeAggregate.
browser.describe("dedupeAggregate", () => {
	it("deduplicates identical messages", () => {
		const slice = [new Error("abc"), new Error("abc")];

		const agg = newAggregate(slice);
		expect(agg).toBeInstanceOf(Aggregate);
		expect(agg?.message).toBe("abc");
		expect(agg?.errors).toHaveLength(2);
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestDedupePluralAggregate.
browser.describe("dedupePluralAggregate", () => {
	it("deduplicates identical messages in plural aggregate output", () => {
		const slice = [new Error("abc"), new Error("abc"), new Error("123")];

		const agg = newAggregate(slice);
		expect(agg).toBeInstanceOf(Aggregate);
		expect(agg?.message).toBe("[abc, 123]");
		expect(agg?.errors).toHaveLength(3);
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestFlattenAndDedupeAggregate.
browser.describe("flattenAndDedupeAggregate", () => {
	it("deduplicates nested aggregate messages", () => {
		const slice = [new Error("abc"), new Error("abc"), newAggregate([new Error("abc")])];

		const agg = newAggregate(slice);
		expect(agg).toBeInstanceOf(Aggregate);
		expect(agg?.message).toBe("abc");
		expect(agg?.errors).toHaveLength(3);
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestFlattenAggregate.
browser.describe("flattenAggregate", () => {
	it("flattens nested aggregate messages for output", () => {
		const slice = [
			new Error("abc"),
			new Error("abc"),
			newAggregate([
				new Error("abc"),
				new Error("def"),
				newAggregate([new Error("def"), new Error("ghi")]),
			]),
		];

		const agg = newAggregate(slice);
		expect(agg).toBeInstanceOf(Aggregate);
		expect(agg?.message).toBe("[abc, def, ghi]");
		expect(agg?.errors).toHaveLength(3);
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors_test.go TestFlatten.
browser.describe("flatten", () => {
	const testCases: Array<{
		agg: Aggregate | undefined;
		expected: Aggregate | undefined;
	}> = [
		{
			agg: undefined,
			expected: undefined,
		},
		{
			agg: new Aggregate([]),
			expected: undefined,
		},
		{
			agg: new Aggregate([new Error("abc")]),
			expected: new Aggregate([new Error("abc")]),
		},
		{
			agg: new Aggregate([new Error("abc"), new Error("def"), new Error("ghi")]),
			expected: new Aggregate([new Error("abc"), new Error("def"), new Error("ghi")]),
		},
		{
			agg: new Aggregate([new Aggregate([new Error("abc")])]),
			expected: new Aggregate([new Error("abc")]),
		},
		{
			agg: new Aggregate([new Aggregate([new Aggregate([new Error("abc")])])]),
			expected: new Aggregate([new Error("abc")]),
		},
		{
			agg: new Aggregate([new Aggregate([new Error("abc"), new Aggregate([new Error("def")])])]),
			expected: new Aggregate([new Error("abc"), new Error("def")]),
		},
		{
			agg: new Aggregate([
				new Aggregate([
					new Aggregate([new Error("abc")]),
					new Error("def"),
					new Aggregate([new Error("ghi")]),
				]),
			]),
			expected: new Aggregate([new Error("abc"), new Error("def"), new Error("ghi")]),
		},
	];

	for (const [i, testCase] of testCases.entries()) {
		it(String(i), () => {
			const agg = flatten(testCase.agg);

			expect(aggregateMessages(agg)).toEqual(aggregateMessages(testCase.expected));
		});
	}
});

function aggregateMessages(agg: Aggregate | undefined): string[] | undefined {
	if (!agg) {
		return undefined;
	}
	return agg.errors.map((err) => err.message);
}
