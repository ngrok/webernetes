// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go MessageCountMap.
export type MessageCountMap = Map<string, number>;

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go Aggregate.
export class Aggregate extends AggregateError {
	constructor(readonly errors: Error[]) {
		super(errors, error(errors));
		this.name = "Aggregate";
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go aggregate.Error.
	override get message(): string {
		return error(this.errors);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go aggregate.Is.
	is(target: Error): boolean {
		return this.visit((err) => err === target || err.message === target.message);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go aggregate.visit.
	private visit(f: (err: Error) => boolean): boolean {
		for (const err of this.errors) {
			if (err instanceof Aggregate) {
				if (err.visit(f)) {
					return true;
				}
				continue;
			}
			if (f(err)) {
				return true;
			}
		}

		return false;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go NewAggregate.
export function newAggregate(errlist: Array<Error | undefined>): Aggregate | undefined {
	if (errlist.length === 0) {
		return undefined;
	}
	const errs: Error[] = [];
	for (const e of errlist) {
		if (e) {
			errs.push(e);
		}
	}
	if (errs.length === 0) {
		return undefined;
	}
	return new Aggregate(errs);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go aggregate.Error.
function error(agg: Error[]): string {
	if (agg.length === 0) {
		return "";
	}
	if (agg.length === 1) {
		return agg[0]?.message ?? "";
	}
	const seenErrs = new Set<string>();
	let result = "";
	visit(agg, (err) => {
		const msg = err.message;
		if (seenErrs.has(msg)) {
			return false;
		}
		seenErrs.add(msg);
		if (seenErrs.size > 1) {
			result += ", ";
		}
		result += msg;
		return false;
	});
	if (seenErrs.size === 1) {
		return result;
	}
	return `[${result}]`;
}

function visit(agg: Error[], f: (err: Error) => boolean): boolean {
	for (const err of agg) {
		if (err instanceof Aggregate) {
			if (visit(err.errors, f)) {
				return true;
			}
			continue;
		}
		if (f(err)) {
			return true;
		}
	}

	return false;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go Matcher.
export type Matcher = (err: Error) => boolean;

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go FilterOut.
export function filterOut(err: Error | undefined, ...fns: Matcher[]): Error | undefined {
	if (!err) {
		return undefined;
	}
	if (err instanceof Aggregate) {
		return newAggregate(filterErrors(err.errors, ...fns));
	}
	if (!matchesError(err, ...fns)) {
		return err;
	}
	return undefined;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go matchesError.
function matchesError(err: Error, ...fns: Matcher[]): boolean {
	for (const fn of fns) {
		if (fn(err)) {
			return true;
		}
	}
	return false;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go filterErrors.
function filterErrors(list: Error[], ...fns: Matcher[]): Error[] {
	const result: Error[] = [];
	for (const err of list) {
		const r = filterOut(err, ...fns);
		if (r) {
			result.push(r);
		}
	}
	return result;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go Flatten.
export function flatten(agg: Aggregate | undefined): Aggregate | undefined {
	const result: Error[] = [];
	if (!agg) {
		return undefined;
	}
	for (const err of agg.errors) {
		if (err instanceof Aggregate) {
			const r = flatten(err);
			if (r) {
				result.push(...r.errors);
			}
		} else {
			result.push(err);
		}
	}
	return newAggregate(result);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go CreateAggregateFromMessageCountMap.
export function createAggregateFromMessageCountMap(
	m: MessageCountMap | undefined,
): Aggregate | undefined {
	if (!m) {
		return undefined;
	}
	const result: Error[] = [];
	for (const [errStr, count] of m) {
		let countStr = "";
		if (count > 1) {
			countStr = ` (repeated ${count} times)`;
		}
		result.push(new Error(`${errStr}${countStr}`));
	}
	return newAggregate(result);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go Reduce.
export function reduce(err: Error | undefined): Error | undefined {
	if (err instanceof Aggregate) {
		switch (err.errors.length) {
			case 1:
				return err.errors[0];
			case 0:
				return undefined;
		}
	}
	return err;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go AggregateGoroutines.
export async function aggregateGoroutines(
	...funcs: Array<() => Error | undefined | Promise<Error | undefined>>
): Promise<Aggregate | undefined> {
	const results = await Promise.all(funcs.map((f) => Promise.resolve(f())));
	const errs: Error[] = [];
	for (const err of results) {
		if (err) {
			errs.push(err);
		}
	}
	return newAggregate(errs);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go ErrPreconditionViolated.
export const errPreconditionViolated = new Error("precondition is violated");
