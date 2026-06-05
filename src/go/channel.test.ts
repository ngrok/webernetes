import { expect, it } from "vitest";
import { Channel, select } from "./channel";
import { browser } from "../test/describe";

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
		await expect(channel.receive()).resolves.toEqual({ ok: false, value: undefined });
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
	//   	close(ch)
	//   	value, ok := <-ch
	//   	fmt.Printf("first value=%q ok=%v\n", value, ok)
	//   	value, ok = <-ch
	//   	fmt.Printf("second value=%q ok=%v\n", value, ok)
	//   }
	//
	// Output:
	//   first value="" ok=false
	//   second value="" ok=false
	it("keeps reporting closed on repeated empty receives after close", async () => {
		const channel = new Channel<string>();

		channel.close();

		await expect(channel.receive()).resolves.toEqual({ ok: false, value: undefined });
		await expect(channel.receive()).resolves.toEqual({ ok: false, value: undefined });
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	close(ch)
	//   	func() {
	//   		defer func() {
	//   			if recover() != nil {
	//   				fmt.Println("close closed panicked")
	//   			}
	//   		}()
	//   		close(ch)
	//   	}()
	//   }
	//
	// Output:
	//   close closed panicked
	it("rejects closing an already closed channel", () => {
		const channel = new Channel<string>();

		channel.close();

		expect(() => channel.close()).toThrow("close of closed channel");
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

		await expect(received).resolves.toEqual({ ok: false, value: undefined });
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

browser.describe("Channel views", () => {
	it("can expose read-only and write-only views over the same channel", async () => {
		const channel = new Channel<string>(1);
		const receiver = channel.readOnly();
		const sender = channel.writeOnly();

		expect(sender.trySend("value")).toBe(true);

		await expect(receiver.receive()).resolves.toEqual({ ok: true, value: "value" });
	});

	it("can select on a read-only channel", async () => {
		const channel = new Channel<string>(1);
		const receiver = channel.readOnly();
		expect(channel.trySend("value")).toBe(true);

		await expect(select().case(receiver, ({ value }) => value)).resolves.toBe("value");
	});
});

browser.describe("select", () => {
	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string, 1)
	//   	ch <- "value"
	//   	select {
	//   	case value, ok := <-ch:
	//   		fmt.Println(value, ok)
	//   	}
	//   }
	//
	// Output:
	//   value true
	it("runs the first ready receive case", async () => {
		const channel = new Channel<string>(1);
		expect(channel.trySend("value")).toBe(true);
		const result = await select().case(channel, ({ value }) => value);
		expect(result).toBe("value");
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	selected := "none"
	//   	select {
	//   	case _, ok := <-ch:
	//   		if ok {
	//   			selected = "channel"
	//   		}
	//   	default:
	//   		selected = "default"
	//   	}
	//   	fmt.Println(selected)
	//   }
	//
	// Output:
	//   default
	it("runs the default case when no channel is ready", async () => {
		const channel = new Channel<string>();
		await expect(
			select()
				.case(channel, () => "channel")
				.default(() => "default"),
		).resolves.toBe("default");
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	var nilCh <-chan string
	//   	ready := make(chan string, 1)
	//   	ready <- "ready"
	//   	select {
	//   	case <-nilCh:
	//   		fmt.Println("nil")
	//   	case value := <-ready:
	//   		fmt.Println(value)
	//   	}
	//   	select {
	//   	case <-nilCh:
	//   		fmt.Println("nil")
	//   	default:
	//   		fmt.Println("default")
	//   	}
	//   }
	//
	// Output:
	//   ready
	//   default
	it("disables undefined receive cases like nil Go channels", async () => {
		const ready = new Channel<string>(1);
		expect(ready.trySend("ready")).toBe(true);

		await expect(
			select()
				.case(undefined, () => "nil")
				.case(ready, ({ value }) => value),
		).resolves.toBe("ready");
		await expect(
			select()
				.case(undefined, () => "nil")
				.default(() => "default"),
		).resolves.toBe("default");
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	select {
	//   	default:
	//   		fmt.Println("default")
	//   	}
	//   }
	//
	// Output:
	//   default
	it("runs a default-only select", async () => {
		await expect(select().default(() => "default")).resolves.toBe("default");
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	close(ch)
	//   	select {
	//   	case value, ok := <-ch:
	//   		fmt.Printf("receive value=%q ok=%v\n", value, ok)
	//   	default:
	//   		fmt.Println("default")
	//   	}
	//   }
	//
	// Output:
	//   receive value="" ok=false
	it("runs a ready closed-channel case instead of default", async () => {
		const channel = new Channel<string>();
		channel.close();

		await expect(
			select()
				.case(channel, ({ ok, value }) => (ok ? value : "closed"))
				.default(() => "default"),
		).resolves.toBe("closed");
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	first := make(chan string)
	//   	second := make(chan int)
	//   	done := make(chan string)
	//   	go func() {
	//   		select {
	//   		case value, ok := <-first:
	//   			if ok {
	//   				done <- value
	//   			}
	//   		case value, ok := <-second:
	//   			if ok {
	//   				done <- fmt.Sprint(value)
	//   			}
	//   		}
	//   	}()
	//   	second <- 2
	//   	fmt.Println(<-done)
	//   }
	//
	// Output:
	//   2
	it("waits until one channel is ready when there is no default case", async () => {
		const first = new Channel<string>();
		const second = new Channel<number>();

		const selecting = select()
			.case(first, ({ value }) => value)
			.case(second, ({ value }) => value);

		void second.send(2);
		const result = await selecting;
		expect(result).toBe(2);
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	ch := make(chan string)
	//   	close(ch)
	//   	select {
	//   	case value, ok := <-ch:
	//   		fmt.Printf("value=%q ok=%v\n", value, ok)
	//   	}
	//   }
	//
	// Output:
	//   value="" ok=false
	it("treats a closed channel as a ready receive case", async () => {
		const channel = new Channel<string>();
		channel.close();
		const closed = await select().case(channel, ({ ok }) => !ok);
		expect(closed).toBe(true);
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
	//   	close(ch)
	//   	select {
	//   	case value, ok := <-ch:
	//   		fmt.Println(value, ok)
	//   	}
	//   	select {
	//   	case value, ok := <-ch:
	//   		fmt.Printf("value=%q ok=%v\n", value, ok)
	//   	}
	//   }
	//
	// Output:
	//   buffered true
	//   value="" ok=false
	it("drains buffered values before a select observes closed", async () => {
		const channel = new Channel<string>(1);
		expect(channel.trySend("buffered")).toBe(true);
		channel.close();

		await expect(select().case(channel, ({ value, ok }) => ({ value, ok }))).resolves.toEqual({
			ok: true,
			value: "buffered",
		});
		await expect(select().case(channel, ({ value, ok }) => ({ value, ok }))).resolves.toEqual({
			ok: false,
			value: undefined,
		});
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	firstCount := 0
	//   	secondCount := 0
	//   	for i := 0; i < 1000; i++ {
	//   		first := make(chan string, 1)
	//   		second := make(chan string, 1)
	//   		first <- "first"
	//   		second <- "second"
	//   		select {
	//   		case <-first:
	//   			firstCount++
	//   		case <-second:
	//   			secondCount++
	//   		}
	//   	}
	//   	fmt.Println(firstCount > 0, secondCount > 0)
	//   }
	//
	// Output:
	//   true true
	it("chooses among multiple ready cases pseudo-randomly instead of always source order", async () => {
		let firstCount = 0;
		let secondCount = 0;

		for (let index = 0; index < 1000; index++) {
			const first = new Channel<string>(1);
			const second = new Channel<string>(1);
			expect(first.trySend("first")).toBe(true);
			expect(second.trySend("second")).toBe(true);
			await select()
				.case(first, () => {
					firstCount++;
				})
				.case(second, () => {
					secondCount++;
				});
		}

		expect(firstCount > 0).toBe(true);
		expect(secondCount > 0).toBe(true);
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	first := make(chan string, 1)
	//   	second := make(chan string, 1)
	//   	first <- "first"
	//   	second <- "second"
	//   	selected := ""
	//   	unselectedWasNotDrained := false
	//   	select {
	//   	case <-first:
	//   		selected = "first"
	//   	case <-second:
	//   		selected = "second"
	//   	}
	//   	switch selected {
	//   	case "first":
	//   		unselectedWasNotDrained = <-second == "second"
	//   	case "second":
	//   		unselectedWasNotDrained = <-first == "first"
	//   	}
	//   	fmt.Println(unselectedWasNotDrained)
	//   }
	//
	// Output:
	//   true
	it("does not drain unselected ready cases", async () => {
		const first = new Channel<string>(1);
		const second = new Channel<string>(1);
		expect(first.trySend("first")).toBe(true);
		expect(second.trySend("second")).toBe(true);
		let unselectedWasNotDrained = false;

		const selected = await select()
			.case(first, () => "first")
			.case(second, () => "second");
		if (selected === "first") {
			const result = await second.receive();
			unselectedWasNotDrained = result.ok && result.value === "second";
		} else {
			const result = await first.receive();
			unselectedWasNotDrained = result.ok && result.value === "first";
		}

		expect(unselectedWasNotDrained).toBe(true);
	});

	// Go check:
	//
	//   package main
	//
	//   import "fmt"
	//
	//   func main() {
	//   	first := make(chan string)
	//   	second := make(chan string, 1)
	//   	done := make(chan string)
	//   	go func() {
	//   		select {
	//   		case value, ok := <-first:
	//   			if ok {
	//   				done <- "first:" + value
	//   			}
	//   		case value, ok := <-second:
	//   			if ok {
	//   				done <- "second:" + value
	//   			}
	//   		}
	//   	}()
	//   	first <- "one"
	//   	fmt.Println(<-done)
	//   	second <- "two"
	//   	fmt.Println(<-second)
	//   }
	//
	// Output:
	//   first:one
	//   two
	it("cancels losing receive cases", async () => {
		const first = new Channel<string>();
		const second = new Channel<string>(1);

		const selecting = select()
			.case(first, () => "first")
			.case(second, () => "second");

		void first.send("one");
		await expect(selecting).resolves.toEqual("first");

		// It's a tiny bit tricky to understand what's being tested here but the
		// idea is that when we switch across channels, if no message is immediately
		// ready we add new listeners to each channel until one becomes ready. This
		// test is making sure that, when a message is received from a channel, the
		// listeners are cleaned up correctly. If they're not, one of these
		// listeners will eat a message and lose it.
		expect(second.trySend("two")).toBe(true);
		await expect(second.receive()).resolves.toEqual({ ok: true, value: "two" });
	});
});
