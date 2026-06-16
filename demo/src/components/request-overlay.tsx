import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type ComponentType,
	type RefObject,
} from "react";
import * as w8s from "webernetes";

import {
	center,
	demoRequestIdHeader,
	demoRequestOriginHeader,
	demoRequestTypeButtonClick,
	demoRequestTypeHeader,
	getHeader,
	healthCheckHeader,
	idFor,
	kubeletIdForNodeName,
	type Point,
	sendRequestButtonId,
} from "../helpers";
import { useClusterPaused } from "./cluster-pause-button";

type FlightKind = "default" | "readiness" | "liveness" | "startup";

interface Flight {
	id: number;
	from: Point;
	to: Point;
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
	const paused = useClusterPaused(cluster);
	const [flights, setFlights] = useState<Flight[]>([]);
	const [warning, setWarning] = useState<Warning>();
	const nextFlightId = useRef(1);
	const nextWarningId = useRef(1);
	const removeFlight = useCallback((id: number) => {
		setFlights((current) => current.filter((item) => item.id !== id));
	}, []);
	const removeWarning = useCallback(() => setWarning(undefined), []);

	useEffect(() => {
		function addFlight(flight: Omit<Flight, "id">): void {
			if (flight.durationMs <= 0) {
				return;
			}
			setFlights((current) => [...current, { ...flight, id: nextFlightId.current++ }]);
		}

		function addWarning(warning: Omit<Warning, "id">): void {
			setWarning({ ...warning, id: nextWarningId.current++ });
		}

		function onRequest(event: w8s.NetworkRequestEvent): void {
			const container = containerRef.current;
			if (!container) {
				return;
			}
			if (isButtonRequestWithNoPodTarget(event)) {
				addWarning({
					anchorId: sendRequestButtonId,
					message: event.error?.message ?? "No ready pods are available for this request.",
				});
				return;
			}
			const flight = getFlight(event, container);
			if (flight) {
				addFlight(flight);
			}
		}

		function onResponse(event: w8s.NetworkResponseEvent): void {
			const container = containerRef.current;
			if (!container) {
				return;
			}
			const flight = getFlight(event, container);
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
	}, [cluster, containerRef]);

	return (
		<div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
			{flights.map((flight) => (
				<FlightDot key={flight.id} flight={flight} onDone={removeFlight} paused={paused} />
			))}
			{warning ? (
				<RequestWarning
					key={warning.id}
					containerRef={containerRef}
					warning={warning}
					onDone={removeWarning}
				/>
			) : undefined}
		</div>
	);
}

function FlightDot({
	flight,
	onDone,
	paused,
}: {
	flight: Flight;
	onDone: (id: number) => void;
	paused: boolean;
}) {
	const dotRef = useRef<HTMLDivElement>(null);
	const animationRef = useRef<Animation | null>(null);

	useLayoutEffect(() => {
		const dot = dotRef.current;
		if (!dot) {
			onDone(flight.id);
			return;
		}

		dot.style.transform = dotTransform(flight.from);
		dot.style.visibility = "visible";
		const animation = dot.animate(
			[{ transform: dotTransform(flight.from) }, { transform: dotTransform(flight.to) }],
			{
				duration: flight.durationMs,
				easing: "linear",
				fill: "forwards",
			},
		);
		animationRef.current = animation;

		void animation.finished.then(
			() => onDone(flight.id),
			() => undefined,
		);
		return () => {
			animationRef.current = null;
			animation.cancel();
		};
	}, [flight, onDone]);

	useLayoutEffect(() => {
		const animation = animationRef.current;
		if (!animation) {
			return;
		}
		if (paused) {
			animation.pause();
		} else {
			animation.play();
		}
	}, [paused]);

	const Dot = flightDotComponent(flight.kind);
	return <Dot innerRef={dotRef} style={{ visibility: "hidden" }} />;
}

type DotProps = {
	innerRef: RefObject<HTMLDivElement | null>;
	style: CSSProperties;
};

function DefaultRequestDot({ innerRef, style }: DotProps) {
	return (
		<div
			ref={innerRef}
			className="absolute left-0 top-0 size-2.5 rounded-full border border-neutral-200/80 bg-neutral-300/65 shadow-sm dark:border-neutral-400/80 dark:bg-neutral-500/70"
			style={style}
		/>
	);
}

function ReadinessProbeDot({ innerRef, style }: DotProps) {
	return (
		<div
			ref={innerRef}
			className="absolute left-0 top-0 size-2.5 rounded-full border border-dotted border-blue-500/70 bg-blue-500/35 shadow-sm"
			style={style}
		/>
	);
}

function LivenessProbeDot({ innerRef, style }: DotProps) {
	return (
		<div
			ref={innerRef}
			className="absolute left-0 top-0 size-2.5 rounded-full border border-dotted border-fuchsia-500/70 bg-fuchsia-500/35 shadow-sm"
			style={style}
		/>
	);
}

function StartupProbeDot({ innerRef, style }: DotProps) {
	return (
		<div
			ref={innerRef}
			className="absolute left-0 top-0 size-2.5 rounded-full border border-dotted border-amber-500/70 bg-amber-500/35 shadow-sm"
			style={style}
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
	onDone: () => void;
}) {
	const warningRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const warningElement = warningRef.current;
		const container = containerRef.current;
		const anchor = document.getElementById(warning.anchorId);
		if (!warningElement || !container || !anchor) {
			onDone();
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
		const timeout = window.setTimeout(onDone, 2500);
		return () => window.clearTimeout(timeout);
	}, [onDone]);

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
	container: HTMLElement,
): Omit<Flight, "id"> | undefined {
	const requestId = getRequestId(event);
	if (!requestId) {
		return undefined;
	}
	const healthCheck = getHealthCheck(event);
	if (healthCheck) {
		return healthCheckFlight(event, container, healthCheckKind(healthCheck));
	}
	const points = visibleChainPoints(event.chain, container);
	if (points.length === 0) {
		return undefined;
	}

	if (isResponseEvent(event)) {
		return responseFlight(event, points, container);
	}
	return requestFlight(event, points, container);
}

function healthCheckFlight(
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent,
	container: HTMLElement,
	kind: FlightKind,
): Omit<Flight, "id"> | undefined {
	const pod = healthCheckPod(event);
	if (!pod) {
		return undefined;
	}
	const nodeName = pod.spec?.nodeName;
	if (!nodeName) {
		return undefined;
	}
	const kubelet = pointForId(kubeletIdForNodeName(nodeName), container);
	const podPoint = pointForId(idFor(pod), container);
	if (isResponseEvent(event)) {
		return buildFlight(podPoint, kubelet, event.latencyMs, kind);
	}
	return buildFlight(kubelet, podPoint, event.latencyMs, kind);
}

function requestFlight(
	event: w8s.NetworkRequestEvent,
	points: readonly Point[],
	container: HTMLElement,
): Omit<Flight, "id"> | undefined {
	const from = requestFlightStart(event, points, container);
	const to = points.at(-1);
	return buildFlight(from, to, event.latencyMs, "default");
}

function responseFlight(
	event: w8s.NetworkResponseEvent,
	points: readonly Point[],
	container: HTMLElement,
): Omit<Flight, "id"> | undefined {
	const from = points[0];
	const to = responseFlightEnd(event, points, container);
	return buildFlight(from, to, event.latencyMs, "default");
}

function requestFlightStart(
	event: w8s.NetworkRequestEvent,
	points: readonly Point[],
	container: HTMLElement,
): Point | undefined {
	if (isButtonRequestFromNode(event)) {
		return getRequestOrigin(event, container) ?? pointForId(sendRequestButtonId, container);
	}
	return points[0] ?? pointForId(sendRequestButtonId, container);
}

function responseFlightEnd(
	event: w8s.NetworkResponseEvent,
	points: readonly Point[],
	container: HTMLElement,
): Point | undefined {
	if (isButtonResponseToNode(event)) {
		return pointForId(sendRequestButtonId, container);
	}
	return points.at(-1);
}

function buildFlight(
	from: Point | undefined,
	to: Point | undefined,
	durationMs: number,
	kind: FlightKind,
): Omit<Flight, "id"> | undefined {
	if (!from || !to || samePoint(from, to)) {
		return undefined;
	}
	return {
		from,
		to,
		durationMs,
		kind,
	};
}

function getRequestId(event: { request: w8s.HttpRequest }): string | undefined {
	return (
		getHeader(event.request.header, demoRequestIdHeader) ??
		getHeader(event.request.header, "X-Webernetes-Request-Id")
	);
}

function getHealthCheck(event: { request: w8s.HttpRequest }): string | undefined {
	return getHeader(event.request.header, healthCheckHeader);
}

function healthCheckKind(value: string): FlightKind {
	switch (value) {
		case "readiness":
		case "liveness":
		case "startup":
			return value;
		default:
			return "default";
	}
}

function healthCheckPod(
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent,
): w8s.V1Pod | undefined {
	return event.chain.find(
		(hop): hop is Extract<w8s.NetworkHop, { type: "pod" }> => hop.type === "pod",
	)?.resource;
}

function getRequestOrigin(
	event: { request: w8s.HttpRequest },
	container: HTMLElement,
): Point | undefined {
	const header = getHeader(event.request.header, demoRequestOriginHeader);
	if (!header) {
		return undefined;
	}
	const [x, y] = header.split(",", 2).map(Number);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return undefined;
	}
	const containerRect = container.getBoundingClientRect();
	return {
		x: x - containerRect.left,
		y: y - containerRect.top,
	};
}

function pointForId(id: string, container: HTMLElement): Point | undefined {
	const element = document.getElementById(id);
	return element ? center(element, container) : undefined;
}

function samePoint(left: Point, right: Point): boolean {
	return left.x === right.x && left.y === right.y;
}

function visibleChainPoints(chain: readonly w8s.NetworkHop[], container: HTMLElement): Point[] {
	return chain.flatMap((hop) => {
		if (hop.type === "external") {
			return [];
		}
		const id = idFor(hop.resource);
		const point = pointForId(id, container);
		return point ? [point] : [];
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

function dotTransform(point: { x: number; y: number }): string {
	return `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
}

function flightDotComponent(kind: FlightKind): ComponentType<DotProps> {
	switch (kind) {
		case "readiness":
			return ReadinessProbeDot;
		case "liveness":
			return LivenessProbeDot;
		case "startup":
			return StartupProbeDot;
		case "default":
			return DefaultRequestDot;
	}
}
