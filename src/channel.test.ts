import { expect, it } from "vitest";
import { Channel } from "./channel";
import { browser } from "./test/describe";

browser.describe("Channel", () => {
	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string, 1)
	//   	select {
	//   	case ch <- "first":
	//   		fmt.Println("first true")
	//   	default:
	//   		fmt.Println("first false")
	//   	}
	//   	select {
	//   	case ch <- "second":
	//   		fmt.Println("second true")
	//   	default:
	//   		fmt.Println("second false")
	//   	}
	//   	fmt.Println(<-ch)
	//   }
	//
	// Output:
	//   first true
	//   second false
	//   first
	it("trySend stores values up to capacity", async () => {
		const channel = new Channel<string>(1);

		expect(channel.trySend("first")).toBe(true);
		expect(channel.trySend("second")).toBe(false);
		await expect(channel.receive()).resolves.toEqual({ ok: true, value: "first" });
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	done := make(chan struct{})
	//   	go func() {
	//   		fmt.Println(<-ch)
	//   		close(done)
	//   	}()
	//   	ch <- "value"
	//   	<-done
	//   }
	//
	// Output:
	//   value
	it("receive waits for a future sender", async () => {
		const channel = new Channel<string>();
		const received = channel.receive();

		expect(channel.trySend("value")).toBe(true);
		await expect(received).resolves.toEqual({ ok: true, value: "value" });
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string, 1)
	//   	ch <- "first"
	//   	sent := make(chan struct{})
	//   	go func() {
	//   		ch <- "second"
	//   		close(sent)
	//   	}()
	//   	select {
	//   	case <-sent:
	//   		fmt.Println("sent before receive")
	//   	default:
	//   		fmt.Println("blocked before receive")
	//   	}
	//   	fmt.Println(<-ch)
	//   	<-sent
	//   	fmt.Println("sent after receive")
	//   	fmt.Println(<-ch)
	//   }
	//
	// Output:
	//   blocked before receive
	//   first
	//   sent after receive
	//   second
	it("send waits while the buffer is full", async () => {
		const channel = new Channel<string>(1);

		await expect(channel.send("first")).resolves.toBeUndefined();
		const sent = channel.send("second");
		await expect(channel.receive()).resolves.toEqual({ ok: true, value: "first" });
		await expect(sent).resolves.toBeUndefined();
		await expect(channel.receive()).resolves.toEqual({ ok: true, value: "second" });
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string, 1)
	//   	ch <- "value"
	//   	close(ch)
	//   	value, ok := <-ch
	//   	fmt.Println(value, ok)
	//   	_, ok = <-ch
	//   	fmt.Println(ok)
	//   	func() {
	//   		defer func() {
	//   			if recover() != nil {
	//   				fmt.Println("send after close panicked")
	//   			}
	//   		}()
	//   		ch <- "after-close"
	//   	}()
	//   }
	//
	// Output:
	//   value true
	//   false
	//   send after close panicked
	it("close drains buffered values and then reports closed", async () => {
		const channel = new Channel<string>(1);

		expect(channel.trySend("value")).toBe(true);
		channel.close();

		await expect(channel.receive()).resolves.toEqual({ ok: true, value: "value" });
		await expect(channel.receive()).resolves.toEqual({ ok: false });
		expect(() => channel.trySend("after-close")).toThrow(/closed channel/);
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	done := make(chan struct{})
	//   	go func() {
	//   		_, ok := <-ch
	//   		fmt.Println(ok)
	//   		close(done)
	//   	}()
	//   	close(ch)
	//   	<-done
	//   }
	//
	// Output:
	//   false
	it("close resolves pending receivers", async () => {
		const channel = new Channel<string>();
		const received = channel.receive();

		channel.close();

		await expect(received).resolves.toEqual({ ok: false });
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string, 1)
	//   	ch <- "buffered"
	//   	done := make(chan struct{})
	//   	go func() {
	//   		defer func() {
	//   			if recover() != nil {
	//   				fmt.Println("blocked send panicked")
	//   			}
	//   			close(done)
	//   		}()
	//   		ch <- "value"
	//   	}()
	//   	close(ch)
	//   	<-done
	//   }
	//
	// Output:
	//   blocked send panicked
	it("close rejects pending senders", async () => {
		const channel = new Channel<string>(1);
		expect(channel.trySend("buffered")).toBe(true);
		const sent = channel.send("value");

		channel.close();

		await expect(sent).rejects.toThrow(/closed channel/);
	});
});

browser.describe("Channel async iteration", () => {
	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	done := make(chan struct{})
	//   	go func() {
	//   		for range ch {
	//   		}
	//   		fmt.Println("done")
	//   		close(done)
	//   	}()
	//   	close(ch)
	//   	<-done
	//   }
	//
	// Output:
	//   done
	it("stops a blocked async iterator when closed", async () => {
		const channel = new Channel<string>();
		const done = (async () => {
			for await (const _value of channel) {
				throw new Error("closed channel should not yield a value");
			}
		})();

		channel.close();

		await expect(done).resolves.toBeUndefined();
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string, 1)
	//   	ch <- "value"
	//   	close(ch)
	//   	for value := range ch {
	//   		fmt.Println(value)
	//   	}
	//   	fmt.Println("done")
	//   }
	//
	// Output:
	//   value
	//   done
	it("drains buffered values before stopping an async iterator after close", async () => {
		const channel = new Channel<string>(1);
		const values: string[] = [];

		expect(channel.trySend("value")).toBe(true);
		channel.close();

		for await (const value of channel) {
			values.push(value);
		}

		expect(values).toEqual(["value"]);
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string, 1)
	//   	done := make(chan struct{})
	//   	go func() {
	//   		for value := range ch {
	//   			fmt.Println(value)
	//   		}
	//   		fmt.Println("done")
	//   		close(done)
	//   	}()
	//   	ch <- "first"
	//   	ch <- "second"
	//   	close(ch)
	//   	<-done
	//   }
	//
	// Output:
	//   first
	//   second
	//   done
	it("can be consumed with for-await", async () => {
		const channel = new Channel<string>(1);
		const values: string[] = [];
		const done = (async () => {
			for await (const value of channel) {
				values.push(value);
			}
		})();

		expect(channel.trySend("first")).toBe(true);
		expect(channel.trySend("second")).toBe(true);
		channel.close();

		await done;
		expect(values).toEqual(["first", "second"]);
	});

	// Go check:
	//
	//   package main
	//
	//   import (
	//   	"fmt"
	//   	"sort"
	//   )
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	results := make(chan string, 2)
	//   	go func() {
	//   		results <- <-ch
	//   	}()
	//   	go func() {
	//   		results <- <-ch
	//   	}()
	//   	ch <- "first"
	//   	ch <- "second"
	//   	values := []string{<-results, <-results}
	//   	sort.Strings(values)
	//   	fmt.Println(values)
	//   }
	//
	// Output:
	//   [first second]
	it("allows concurrent iterators to compete for values", async () => {
		const channel = new Channel<string>();
		const first = channel[Symbol.asyncIterator]();
		const second = channel[Symbol.asyncIterator]();

		const firstNext = first.next();
		const secondNext = second.next();
		expect(channel.trySend("first")).toBe(true);
		expect(channel.trySend("second")).toBe(true);
		channel.close();

		await expect(firstNext).resolves.toEqual({ done: false, value: "first" });
		await expect(secondNext).resolves.toEqual({ done: false, value: "second" });
		await expect(first.next()).resolves.toEqual({ done: true });
		await expect(second.next()).resolves.toEqual({ done: true });
	});
});
