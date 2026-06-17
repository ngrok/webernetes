import {
	CodeBlock,
	createMantleCodeBlockValue,
	decorateHighlightedHtml,
	type MantleCodeBlockValue,
} from "@ngrok/mantle/code-block";
import { HoverCard } from "@ngrok/mantle/hover-card";
import { useAppliedTheme } from "@ngrok/mantle/theme";
import {
	forwardRef,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ForwardRefExoticComponent,
	type HTMLAttributes,
	type RefAttributes,
	type RefObject,
} from "react";
import { codeToHtml } from "shiki";
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

type FlightKind = "default" | "failed" | "readiness" | "liveness" | "startup";

interface Flight {
	id: number;
	from: Point;
	to: Point;
	durationMs: number;
	kind: FlightKind;
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent;
}

interface Warning {
	id: number;
	anchorId: string;
	message: string;
}

interface HeaderEntry {
	name: string;
	value: string;
}

interface TooltipExchange {
	line: string;
	headers: HeaderEntry[];
	body?: string;
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
	return (
		<HoverCard.Root closeDelay={200} openDelay={0}>
			<HoverCard.Trigger asChild>
				<Dot
					ref={dotRef}
					className={paused ? "pointer-events-auto" : ""}
					style={{ visibility: "hidden" }}
				/>
			</HoverCard.Trigger>
			{paused ? <RequestHoverCardContent event={flight.event} /> : undefined}
		</HoverCard.Root>
	);
}

type DotProps = HTMLAttributes<HTMLDivElement> & {
	style: CSSProperties;
};

type DotComponent = ForwardRefExoticComponent<DotProps & RefAttributes<HTMLDivElement>>;

const DefaultRequestDot = forwardRef<HTMLDivElement, DotProps>(function DefaultRequestDot(
	{ className = "", ...props },
	ref,
) {
	return (
		<div
			ref={ref}
			className={`absolute left-0 top-0 z-20 size-2.5 rounded-full border border-neutral-200/80 bg-neutral-300/65 shadow-sm hover:z-[1000] dark:border-neutral-400/80 dark:bg-neutral-500/70 ${className}`}
			{...props}
		/>
	);
});

const FailedRequestDot = forwardRef<HTMLDivElement, DotProps>(function FailedRequestDot(
	{ className = "", ...props },
	ref,
) {
	return (
		<div
			ref={ref}
			className={`border-danger-600 bg-danger-500/80 absolute left-0 top-0 z-20 size-2.5 rounded-full border shadow-sm hover:z-[1000] ${className}`}
			{...props}
		/>
	);
});

const ReadinessProbeDot = forwardRef<HTMLDivElement, DotProps>(function ReadinessProbeDot(
	{ className = "", ...props },
	ref,
) {
	return (
		<div
			ref={ref}
			className={`absolute left-0 top-0 z-20 size-2.5 rounded-full border border-dotted border-blue-500/70 bg-blue-500/35 shadow-sm hover:z-[1000] ${className}`}
			{...props}
		/>
	);
});

const LivenessProbeDot = forwardRef<HTMLDivElement, DotProps>(function LivenessProbeDot(
	{ className = "", ...props },
	ref,
) {
	return (
		<div
			ref={ref}
			className={`absolute left-0 top-0 z-20 size-2.5 rounded-full border border-dotted border-fuchsia-500/70 bg-fuchsia-500/35 shadow-sm hover:z-[1000] ${className}`}
			{...props}
		/>
	);
});

const StartupProbeDot = forwardRef<HTMLDivElement, DotProps>(function StartupProbeDot(
	{ className = "", ...props },
	ref,
) {
	return (
		<div
			ref={ref}
			className={`absolute left-0 top-0 z-20 size-2.5 rounded-full border border-dotted border-amber-500/70 bg-amber-500/35 shadow-sm hover:z-[1000] ${className}`}
			{...props}
		/>
	);
});

function RequestHoverCardContent({
	event,
}: {
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent;
}) {
	const request = useMemo(() => formatRequest(event.request), [event.request]);
	const response = useMemo(() => formatResponseEvent(event), [event]);

	return (
		<HoverCard.Content
			side="bottom"
			align="center"
			sideOffset={8}
			className="text-strong min-w-72 max-w-[min(34rem,calc(100vw-2rem))] p-3 text-left text-xs"
			style={{ width: "max-content" }}
		>
			<div className="space-y-2">
				<RequestTooltipSection title="Request" exchange={request} />
				{response ? <RequestTooltipSection title="Response" exchange={response} /> : undefined}
			</div>
		</HoverCard.Content>
	);
}

function RequestTooltipSection({ title, exchange }: { title: string; exchange: TooltipExchange }) {
	return (
		<div className="space-y-1">
			<div className="text-accent-600 font-sans text-[0.6875rem] font-semibold uppercase">
				{title}
			</div>
			<div className="w-full overflow-auto font-mono text-[0.6875rem] leading-snug">
				<div className="text-warning-600 font-semibold">{exchange.line}</div>
				{exchange.headers.length > 0 ? (
					<div>
						{exchange.headers.map((header, index) => (
							<div key={`${header.name}-${index}`}>
								<span className="text-muted font-semibold">{header.name}</span>
								<span className="text-muted">: {header.value}</span>
							</div>
						))}
					</div>
				) : undefined}
				{exchange.body ? <RequestTooltipBody body={exchange.body} /> : undefined}
			</div>
		</div>
	);
}

function RequestTooltipBody({ body }: { body: string }) {
	const code = useMemo(() => parseJsonBody(body), [body]);
	if (!code) {
		return (
			<pre className="mt-2 max-h-60 w-full overflow-auto whitespace-pre font-mono text-[0.6875rem] leading-snug">
				{body}
			</pre>
		);
	}
	return <HighlightedJsonCode code={code} />;
}

function HighlightedJsonCode({ code }: { code: string }) {
	const appliedTheme = useAppliedTheme();
	const shikiTheme = appliedTheme.startsWith("dark") ? "github-dark" : "github-light";
	const [highlightedHtml, setHighlightedHtml] = useState<string>();

	useEffect(() => {
		let cancelled = false;
		void highlightJson(code, shikiTheme).then(
			(html) => {
				if (!cancelled) {
					setHighlightedHtml(html);
				}
				return null;
			},
			() => {
				if (!cancelled) {
					setHighlightedHtml(undefined);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [code, shikiTheme]);

	const value = useMemo<MantleCodeBlockValue>(
		() =>
			createMantleCodeBlockValue({
				language: "json",
				code,
				preHtml: highlightedHtml,
				showLineNumbers: false,
			}),
		[code, highlightedHtml],
	);

	return (
		<CodeBlock.Root className="mt-2 w-full max-w-full border-0 bg-transparent text-[0.6875rem]">
			<CodeBlock.Body>
				<CodeBlock.Code
					value={value}
					className="max-h-60 w-full text-[0.6875rem] leading-snug"
					style={{ margin: 0, overflow: "auto", padding: 0 }}
				/>
			</CodeBlock.Body>
		</CodeBlock.Root>
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
		return buildFlight(event, podPoint, kubelet, event.latencyMs, kind);
	}
	return buildFlight(event, kubelet, podPoint, event.latencyMs, kind);
}

function requestFlight(
	event: w8s.NetworkRequestEvent,
	points: readonly Point[],
	container: HTMLElement,
): Omit<Flight, "id"> | undefined {
	const from = requestFlightStart(event, points, container);
	const to = points.at(-1);
	return buildFlight(event, from, to, event.latencyMs, "default");
}

function responseFlight(
	event: w8s.NetworkResponseEvent,
	points: readonly Point[],
	container: HTMLElement,
): Omit<Flight, "id"> | undefined {
	const from = points[0];
	const to = responseFlightEnd(event, points, container);
	return buildFlight(
		event,
		from,
		to,
		event.latencyMs,
		failedResponse(event) ? "failed" : "default",
	);
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
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent,
	from: Point | undefined,
	to: Point | undefined,
	durationMs: number,
	kind: FlightKind,
): Omit<Flight, "id"> | undefined {
	if (!from || !to || samePoint(from, to)) {
		return undefined;
	}
	return {
		event,
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

function formatRequest(request: w8s.HttpRequest): TooltipExchange {
	return {
		line: `${request.method} ${request.url.toString()}`,
		headers: requestHeaders(request),
		body: request.body,
	};
}

function formatResponseEvent(
	event: w8s.NetworkRequestEvent | w8s.NetworkResponseEvent,
): TooltipExchange | undefined {
	if (!isResponseEvent(event)) {
		return undefined;
	}
	if (event.error) {
		return {
			line: `Error: ${event.error.message}`,
			headers: [],
		};
	}
	if (!event.response) {
		return {
			line: "No response",
			headers: [],
		};
	}
	return {
		line: `HTTP ${event.response.status}`,
		headers: headerEntries(event.response.header ?? {}),
		body: event.response.body,
	};
}

function headerEntries(headers: w8s.HttpHeader): HeaderEntry[] {
	return Object.entries(headers).flatMap(([name, values]) =>
		values.map((value) => ({ name, value })),
	);
}

function requestHeaders(request: w8s.HttpRequest): HeaderEntry[] {
	const headers = headerEntries(request.header);
	if (getHeader(request.header, "Host") !== undefined) {
		return headers;
	}
	return [{ name: "Host", value: request.host }, ...headers];
}

function parseJsonBody(body: string): string | undefined {
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return JSON.stringify(parsed, undefined, 2);
	} catch {
		return undefined;
	}
}

const highlightedJsonCache = new Map<string, Promise<string>>();

async function highlightJson(code: string, theme: string): Promise<string> {
	const cacheKey = `${theme}\n${code}`;
	let promise = highlightedJsonCache.get(cacheKey);
	if (!promise) {
		promise = renderHighlightedJson(code, theme);
		highlightedJsonCache.set(cacheKey, promise);
	}
	return promise;
}

async function renderHighlightedJson(code: string, theme: string): Promise<string> {
	const html = await codeToHtml(code, {
		lang: "json",
		theme,
	});
	return decorateHighlightedHtml({
		html: extractShikiCodeHtml(html),
		showLineNumbers: false,
	});
}

function extractShikiCodeHtml(html: string): string {
	// Shiki returns a full <pre><code> block, but Mantle CodeBlock renders that wrapper itself.
	const template = document.createElement("template");
	template.innerHTML = html;
	return template.content.querySelector("code")?.innerHTML ?? html;
}

function failedResponse(event: w8s.NetworkResponseEvent): boolean {
	return (event.response?.status ?? 0) >= 400 || Boolean(event.error);
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

function flightDotComponent(kind: FlightKind): DotComponent {
	switch (kind) {
		case "readiness":
			return ReadinessProbeDot;
		case "liveness":
			return LivenessProbeDot;
		case "startup":
			return StartupProbeDot;
		case "failed":
			return FailedRequestDot;
		case "default":
			return DefaultRequestDot;
	}
}
