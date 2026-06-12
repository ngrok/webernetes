import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import * as w8s from "webernetes";

import {
	center,
	demoRequestIdHeader,
	demoRequestTypeButtonClick,
	demoRequestTypeHeader,
	getHeader,
	idFor,
	sendRequestButtonId,
} from "../helpers";

type FlightKind = "request" | "success" | "error";

interface Flight {
	id: number;
	fromId: string;
	toId: string;
	durationMs: number;
	kind: FlightKind;
}

interface Warning {
	id: number;
	anchorId: string;
	message: string;
}

export function RequestOverlay({
	cluster,
	containerRef,
}: {
	cluster: w8s.Cluster;
	containerRef: RefObject<HTMLElement | null>;
}) {
	const [flights, setFlights] = useState<Flight[]>([]);
	const [warnings, setWarnings] = useState<Warning[]>([]);
	const nextFlightId = useRef(1);
	const nextWarningId = useRef(1);
	const removeFlight = useCallback((id: number) => {
		setFlights((current) => current.filter((item) => item.id !== id));
	}, []);
	const removeWarning = useCallback((id: number) => {
		setWarnings((current) => current.filter((item) => item.id !== id));
	}, []);

	useEffect(() => {
		function addFlight(flight: Omit<Flight, "id">): void {
			if (flight.durationMs <= 0) {
				return;
			}
			setFlights((current) => [...current, { ...flight, id: nextFlightId.current++ }]);
		}

		function addWarning(warning: Omit<Warning, "id">): void {
			setWarnings((current) => [...current, { ...warning, id: nextWarningId.current++ }]);
		}

		function onRequest(event: w8s.NetworkRequestEvent): void {
			if (isButtonRequestWithNoPodTarget(event)) {
				addWarning({
					anchorId: sendRequestButtonId,
					message: event.error?.message ?? "No ready pods are available for this request.",
				});
				return;
			}
			const flight = getFlight(event);
			if (flight) {
				addFlight(flight);
			}
		}

		function onResponse(event: w8s.NetworkResponseEvent): void {
			const flight = getFlight(event);
			if (flight) {
				addFlight(flight);
			}
		}

		cluster.on("request", onRequest);
		cluster.on("response", onResponse);

		return () => {
			cluster.off("request", onRequest);
			cluster.off("response", onResponse);
		};
	}, [cluster]);

	return (
		<div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
			{flights.map((flight) => (
				<FlightDot
					key={flight.id}
					containerRef={containerRef}
					flight={flight}
					onDone={removeFlight}
				/>
			))}
			{warnings.map((warning) => (
				<RequestWarning
					key={warning.id}
					containerRef={containerRef}
					warning={warning}
					onDone={removeWarning}
				/>
			))}
		</div>
	);
}

function FlightDot({
	containerRef,
	flight,
	onDone,
}: {
	containerRef: RefObject<HTMLElement | null>;
	flight: Flight;
	onDone: (id: number) => void;
}) {
	const dotRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const dot = dotRef.current;
		const container = containerRef.current;
		const from = document.getElementById(flight.fromId);
		const to = document.getElementById(flight.toId);
		if (!dot || !container || !from || !to) {
			onDone(flight.id);
			return;
		}

		const fromPoint = center(from, container);
		const toPoint = center(to, container);
		dot.style.transform = dotTransform(fromPoint);
		dot.style.visibility = "visible";
		const animation = dot.animate(
			[{ transform: dotTransform(fromPoint) }, { transform: dotTransform(toPoint) }],
			{
				duration: flight.durationMs,
				easing: "linear",
				fill: "forwards",
			},
		);

		void animation.finished.then(
			() => onDone(flight.id),
			() => undefined,
		);
		return () => animation.cancel();
	}, [containerRef, flight, onDone]);

	return (
		<div
			ref={dotRef}
			className={`absolute left-0 top-0 size-2.5 rounded-full shadow-sm ${flightClassName(flight.kind)}`}
			style={{ visibility: "hidden" }}
		/>
	);
}

function RequestWarning({
	containerRef,
	warning,
	onDone,
}: {
	containerRef: RefObject<HTMLElement | null>;
	warning: Warning;
	onDone: (id: number) => void;
}) {
	const warningRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const warningElement = warningRef.current;
		const container = containerRef.current;
		const anchor = document.getElementById(warning.anchorId);
		if (!warningElement || !container || !anchor) {
			onDone(warning.id);
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		const warningRect = warningElement.getBoundingClientRect();
		const x = anchorRect.left - containerRect.left + anchorRect.width / 2 - warningRect.width / 2;
		const y = anchorRect.top - containerRect.top - warningRect.height - 10;
		warningElement.style.transform = `translate(${x}px, ${Math.max(0, y)}px)`;
		warningElement.style.visibility = "visible";
	}, [containerRef, onDone, warning]);

	useEffect(() => {
		const timeout = window.setTimeout(() => onDone(warning.id), 2500);
		return () => window.clearTimeout(timeout);
	}, [onDone, warning.id]);

	return (
		<div
			ref={warningRef}
			className="border-danger-600 bg-danger-600 absolute left-0 top-0 max-w-64 rounded-md border px-3 py-2 text-xs font-medium text-white shadow-lg"
			style={{ visibility: "hidden" }}
		>
			{warning.message}
		</div>
	);
}

function getFlight(
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent,
): Omit<Flight, "id"> | undefined {
	if (!getHeader(event.request.header, demoRequestIdHeader)) {
		return undefined;
	}
	const ids = visibleChainIds(event.chain);
	if (ids.length === 0) {
		return undefined;
	}
	const response = isResponseEvent(event);
	const fromId = response
		? ids[0]
		: isButtonRequestFromNode(event)
			? sendRequestButtonId
			: (ids[0] ?? sendRequestButtonId);
	const toId = response
		? isButtonResponseToNode(event)
			? sendRequestButtonId
			: ids.at(-1)
		: ids.at(-1);
	if (!fromId || !toId || fromId === toId) {
		return undefined;
	}
	return {
		fromId,
		toId,
		durationMs: event.latencyMs,
		kind: response ? responseKind(event) : "request",
	};
}

function visibleChainIds(chain: readonly w8s.NetworkHop[]): string[] {
	return chain.flatMap((hop) => {
		if (hop.type === "external") {
			return [];
		}
		const id = idFor(hop.resource);
		return document.getElementById(id) ? [id] : [];
	});
}

function isButtonRequest(event: { request: w8s.HttpRequest }): boolean {
	return getHeader(event.request.header, demoRequestTypeHeader) === demoRequestTypeButtonClick;
}

function isResponseEvent(
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent,
): event is w8s.NetworkResponseEvent {
	return "response" in event;
}

function isButtonRequestFromNode(event: w8s.NetworkRequestEvent): boolean {
	return isButtonRequest(event) && event.chain[0]?.type === "node";
}

function isButtonRequestWithNoPodTarget(event: w8s.NetworkRequestEvent): boolean {
	return (
		Boolean(event.error) && isButtonRequestFromNode(event) && !hasVisiblePodTarget(event.chain)
	);
}

function hasVisiblePodTarget(chain: readonly w8s.NetworkHop[]): boolean {
	return chain.some(
		(hop) => hop.type === "pod" && Boolean(document.getElementById(idFor(hop.resource))),
	);
}

function isButtonResponseToNode(event: w8s.NetworkResponseEvent): boolean {
	return isButtonRequest(event) && event.chain.at(-1)?.type === "node";
}

function responseKind(event: w8s.NetworkResponseEvent): FlightKind {
	if (event.error || (event.response?.status ?? 0) >= 400) {
		return "error";
	}
	return "success";
}

function dotTransform(point: { x: number; y: number }): string {
	return `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
}

function flightClassName(kind: FlightKind): string {
	switch (kind) {
		case "request":
			return "bg-blue-500";
		case "success":
			return "bg-green-500";
		case "error":
			return "bg-red-500";
	}
}
