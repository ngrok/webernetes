// Models kubernetes/third_party/forked/golang/expansion/expand.go operator.
const operator = "$";

// Models kubernetes/third_party/forked/golang/expansion/expand.go referenceOpener.
const referenceOpener = "(";

// Models kubernetes/third_party/forked/golang/expansion/expand.go referenceCloser.
const referenceCloser = ")";

// Models kubernetes/third_party/forked/golang/expansion/expand.go syntaxWrap.
function syntaxWrap(input: string): string {
	return `${operator}${referenceOpener}${input}${referenceCloser}`;
}

// Models kubernetes/third_party/forked/golang/expansion/expand.go MappingFuncFor.
export function mappingFuncFor(...contexts: Array<Map<string, string>>): (input: string) => string {
	return (input: string): string => {
		for (const vars of contexts) {
			const value = vars.get(input);
			if (value !== undefined) {
				return value;
			}
		}
		return syntaxWrap(input);
	};
}

// Models kubernetes/third_party/forked/golang/expansion/expand.go Expand.
export function expand(input: string, mapping: (input: string) => string): string {
	let output = "";
	let checkpoint = 0;
	for (let cursor = 0; cursor < input.length; cursor++) {
		if (input[cursor] !== operator || cursor + 1 >= input.length) {
			continue;
		}
		output += input.slice(checkpoint, cursor);
		const [read, isVar, advance] = tryReadVariableName(input.slice(cursor + 1));
		output += isVar ? mapping(read) : read;
		cursor += advance;
		checkpoint = cursor + 1;
	}
	return output + input.slice(checkpoint);
}

// Models kubernetes/third_party/forked/golang/expansion/expand.go tryReadVariableName.
function tryReadVariableName(input: string): [read: string, isVar: boolean, advance: number] {
	const first = input[0];
	switch (first) {
		case operator:
			return [operator, false, 1];
		case referenceOpener: {
			const closer = input.indexOf(referenceCloser, 1);
			if (closer !== -1) {
				return [input.slice(1, closer), true, closer + 1];
			}
			return [`${operator}${referenceOpener}`, false, 1];
		}
		default:
			return [`${operator}${first ?? ""}`, false, first === undefined ? 0 : 1];
	}
}
