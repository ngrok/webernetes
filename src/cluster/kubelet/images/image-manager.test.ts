// oxlint-disable jest/expect-expect
// oxlint-disable jest/no-standalone-expect
import { expect, it } from "vitest";
import type { V1Container, V1ObjectReference, V1Pod } from "../../../client";
import { newFakeRecorder } from "../../../client-go/tools/record/fake";
import { newBackOff } from "../../../client-go/util/flowcontrol/backoff";
import { Clock } from "../../../clock";
import { background } from "../../../go/context";
import { browser } from "../../../test/describe";
import { FakeRuntime } from "../container/testing";
import { KubeletImageManager, applyDefaultImageTag, evalCRIPullErr } from "./image-manager";
import { ImagePullError } from "./types";
import type * as context from "../../../go/context";
import type { ImagePodPullingTimeRecorder, ImagePullManager } from "./image-manager";

// Models kubernetes/pkg/kubelet/images/image_manager_test.go mockPodPullingTimeRecorder.
class mockPodPullingTimeRecorder implements ImagePodPullingTimeRecorder {
	readonly startedPullingRecorded = new Map<string, boolean>();
	readonly finishedPullingRecorded = new Map<string, boolean>();

	// Models kubernetes/pkg/kubelet/images/image_manager_test.go mockPodPullingTimeRecorder.RecordImageStartedPulling.
	recordImageStartedPulling(podUID: string): void {
		this.startedPullingRecorded.set(podUID, true);
	}

	// Models kubernetes/pkg/kubelet/images/image_manager_test.go mockPodPullingTimeRecorder.RecordImageFinishedPulling.
	recordImageFinishedPulling(podUID: string): void {
		if (this.startedPullingRecorded.get(podUID)) {
			this.finishedPullingRecorded.set(podUID, true);
		}
	}

	// Models kubernetes/pkg/kubelet/images/image_manager_test.go mockPodPullingTimeRecorder.reset.
	reset(): void {
		this.startedPullingRecorded.clear();
		this.finishedPullingRecorded.clear();
	}
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go pullerExpects.
interface PullerExpects {
	calls: string[];
	err: Error | undefined;
	shouldRecordStartedPullingTime: boolean;
	shouldRecordFinishedPullingTime: boolean;
	events: string[];
	msg: string;
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go pullerExpects.err sentinel values.
type ImagePullErrorReason = ConstructorParameters<typeof ImagePullError>[0];

// Models kubernetes/pkg/kubelet/images/image_manager_test.go pullerExpects.err sentinel values.
function imagePullErr(reason: ImagePullErrorReason): Error {
	return new ImagePullError(reason, "");
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go mockImagePullManagerConfig.
interface mockImagePullManagerConfig {
	allowAll: boolean;
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go mockImagePullManager.
class mockImagePullManager implements ImagePullManager {
	config: mockImagePullManagerConfig | undefined;

	constructor(config: mockImagePullManagerConfig | undefined) {
		this.config = config;
	}

	// Models kubernetes/pkg/kubelet/images/pullmanager/noop_pull_manager.go NoopImagePullManager.RecordPullIntent.
	async recordPullIntent(_image: string): Promise<Error | undefined> {
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/images/pullmanager/noop_pull_manager.go NoopImagePullManager.RecordImagePulled.
	async recordImagePulled(
		_ctx: context.Context,
		_image: string,
		_imageRef: string,
		_credentials: unknown | undefined,
	): Promise<void> {}

	// Models kubernetes/pkg/kubelet/images/pullmanager/noop_pull_manager.go NoopImagePullManager.RecordImagePullFailed.
	async recordImagePullFailed(_ctx: context.Context, _image: string): Promise<void> {}

	// Models kubernetes/pkg/kubelet/images/image_manager_test.go mockImagePullManager.MustAttemptImagePull.
	async mustAttemptImagePull(
		_ctx: context.Context,
		_image: string,
		_imageRef: string,
		_getPodCredentials: () => Promise<[pullCredentials: unknown[], err: Error | undefined]>,
	): Promise<[pullRequired: boolean, err: Error | undefined]> {
		if (this.config === undefined || this.config.allowAll) {
			return [false, undefined];
		}
		return [true, undefined];
	}
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go pullerTestCase.
interface PullerTestCase {
	testName: string;
	containerImage: string;
	policy: string;
	pullSecrets?: unknown[];
	allowedCredentials?: mockImagePullManagerConfig;
	inspectErr?: Error;
	pullerErr?: Error;
	qps: number;
	burst: number;
	expected: PullerExpects[];
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go pullerTestEnv fakeClock setup.
function newTestClock(): Clock {
	const clock = new Clock();
	clock.pause();
	return clock;
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestImagePullPrecheck object reference fixture.
function newObjectRef(): V1ObjectReference {
	return {};
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go pullerTestEnv.
function pullerTestEnv(c: PullerTestCase, _serialized: boolean, maxParallelImagePulls?: number) {
	const container = {
		args: [],
		command: [],
		env: [],
		envFrom: [],
		image: c.containerImage,
		imagePullPolicy: c.policy,
		name: "container_name",
		ports: [],
		resizePolicy: [],
		resources: {},
		restartPolicy: "",
		restartPolicyRules: [],
		stdin: false,
		stdinOnce: false,
		terminationMessagePath: "",
		terminationMessagePolicy: "",
		tty: false,
		volumeDevices: [],
		volumeMounts: [],
		workingDir: "",
	} satisfies V1Container;

	const clock = newTestClock();
	const fakeRuntime = new FakeRuntime();
	fakeRuntime.imageList = [
		{
			id: "present_image:latest",
			repoTags: [],
			repoDigests: [],
			size: 0,
			spec: { image: "present_image:latest" },
			pinned: false,
		},
	];
	fakeRuntime.inspectErr = c.inspectErr;
	fakeRuntime.err = c.pullerErr;
	const fakeRecorder = newFakeRecorder(20);
	const fakePodPullingTimeRecorder = new mockPodPullingTimeRecorder();
	const pullManager = new mockImagePullManager(c.allowedCredentials);
	if (pullManager.config === undefined) {
		pullManager.config = { allowAll: true };
	}
	const imageManager = new KubeletImageManager({
		recorder: fakeRecorder,
		imageService: fakeRuntime,
		imagePullManager: pullManager,
		clock,
		imageBackOff: newBackOff(1000, 60_000, clock),
		podPullingTimeRecorder: fakePodPullingTimeRecorder,
		maxParallelImagePulls,
		qps: c.qps,
		burst: c.burst,
	});
	return [
		imageManager,
		clock,
		fakeRuntime,
		container,
		fakePodPullingTimeRecorder,
		fakeRecorder,
	] as const;
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go pullerTestCases.
function pullerTestCases(): PullerTestCase[] {
	return noFGPullerTestCases();
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go noFGPullerTestCases.
function noFGPullerTestCases(): PullerTestCase[] {
	return [
		{
			testName: "image missing, pull",
			containerImage: "missing_image",
			policy: "IfNotPresent",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["GetImageRef", "PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: ["Pulling", "Pulled"],
					msg: "",
				},
			],
		},
		{
			testName: "image present, allow all, don't pull ",
			containerImage: "present_image",
			policy: "IfNotPresent",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["GetImageRef"],
					err: undefined,
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulled"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: undefined,
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulled"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: undefined,
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulled"],
					msg: "",
				},
			],
		},
		{
			testName: "image present, pull",
			containerImage: "present_image",
			policy: "Always",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: ["Pulling", "Pulled"],
					msg: "",
				},
				{
					calls: ["PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: ["Pulling", "Pulled"],
					msg: "",
				},
				{
					calls: ["PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: ["Pulling", "Pulled"],
					msg: "",
				},
			],
		},
		{
			testName: "image missing, never pull",
			containerImage: "missing_image",
			policy: "Never",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ErrImageNeverPull"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["ErrImageNeverPull"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ErrImageNeverPull"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["ErrImageNeverPull"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ErrImageNeverPull"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["ErrImageNeverPull"],
					msg: "",
				},
			],
		},
		{
			testName: "image missing, pull if not present, fail on image inspect",
			containerImage: "missing_image",
			policy: "IfNotPresent",
			inspectErr: new Error("unknown inspectError"),
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ErrImageInspect"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["InspectFailed"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ErrImageInspect"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["InspectFailed"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ErrImageInspect"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["InspectFailed"],
					msg: "",
				},
			],
		},
		{
			testName: "image missing, unable to fetch",
			containerImage: "typo_image",
			policy: "IfNotPresent",
			inspectErr: undefined,
			pullerErr: new Error("404"),
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["GetImageRef", "PullImage"],
					err: imagePullErr("ErrImagePull"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "",
				},
				{
					calls: ["GetImageRef", "PullImage"],
					err: imagePullErr("ErrImagePull"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ImagePullBackOff"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["BackOff"],
					msg: "",
				},
				{
					calls: ["GetImageRef", "PullImage"],
					err: imagePullErr("ErrImagePull"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ImagePullBackOff"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["BackOff"],
					msg: "",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ImagePullBackOff"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["BackOff"],
					msg: "",
				},
			],
		},
		{
			containerImage: "present_image",
			testName: "image present and qps>0, pull",
			policy: "Always",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 400.0,
			burst: 600,
			expected: [
				{
					calls: ["PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: ["Pulling", "Pulled"],
					msg: "",
				},
				{
					calls: ["PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: ["Pulling", "Pulled"],
					msg: "",
				},
				{
					calls: ["PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: ["Pulling", "Pulled"],
					msg: "",
				},
			],
		},
		{
			containerImage: "present_image",
			testName: "image present and excessive qps rate, pull",
			policy: "Always",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 2000.0,
			burst: 0,
			expected: [
				{
					calls: [],
					err: imagePullErr("ErrImagePull"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "",
				},
				{
					calls: [],
					err: imagePullErr("ErrImagePull"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "",
				},
				{
					calls: [],
					err: imagePullErr("ImagePullBackOff"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["BackOff"],
					msg: "",
				},
			],
		},
		{
			testName: "invalid image name, no pull",
			containerImage: "FAILED_IMAGE",
			policy: "Always",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: [],
					err: imagePullErr("InvalidImageName"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["InspectFailed"],
					msg: "",
				},
			],
		},
		{
			testName: "invalid image name with http, no pull",
			containerImage: "http://url",
			policy: "Always",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: [],
					err: imagePullErr("InvalidImageName"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["InspectFailed"],
					msg: "",
				},
			],
		},
		{
			testName: "invalid image name with sha256, no pull",
			containerImage: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			policy: "Always",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: [],
					err: imagePullErr("InvalidImageName"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["InspectFailed"],
					msg: "",
				},
			],
		},
		{
			testName: "image missing, SignatureValidationFailed",
			containerImage: "typo_image",
			policy: "IfNotPresent",
			inspectErr: undefined,
			pullerErr: new Error("SignatureValidationFailed"),
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["GetImageRef", "PullImage"],
					err: imagePullErr("SignatureValidationFailed"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "image pull failed for typo_image because the signature validation failed",
				},
				{
					calls: ["GetImageRef", "PullImage"],
					err: imagePullErr("SignatureValidationFailed"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "image pull failed for typo_image because the signature validation failed",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ImagePullBackOff"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["BackOff"],
					msg: 'Back-off pulling image "typo_image": SignatureValidationFailed: image pull failed for typo_image because the signature validation failed',
				},
				{
					calls: ["GetImageRef", "PullImage"],
					err: imagePullErr("SignatureValidationFailed"),
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: false,
					events: ["Pulling", "Failed"],
					msg: "image pull failed for typo_image because the signature validation failed",
				},
				{
					calls: ["GetImageRef"],
					err: imagePullErr("ImagePullBackOff"),
					shouldRecordStartedPullingTime: false,
					shouldRecordFinishedPullingTime: false,
					events: ["BackOff"],
					msg: 'Back-off pulling image "typo_image": SignatureValidationFailed: image pull failed for typo_image because the signature validation failed',
				},
			],
		},
	];
}

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestParallelPuller.
browser.describe("TestParallelPuller", () => {
	const cases = pullerTestCases();

	const useSerializedEnv = false;
	for (const c of cases) {
		it(c.testName, async () => {
			const ctx = background();
			const [puller, clock, fakeRuntime, container, fakePodPullingTimeRecorder] = pullerTestEnv(
				c,
				useSerializedEnv,
				undefined,
			);

			const pod = {
				metadata: {
					name: "test_pod",
					namespace: "test-ns",
					uid: "bar",
					resourceVersion: "42",
				},
				spec: { containers: [] },
			} satisfies V1Pod;
			const podSandboxConfig = {
				metadata: {
					name: pod.metadata.name,
					namespace: pod.metadata.namespace,
					uid: pod.metadata.uid,
					attempt: 0,
				},
			};

			for (const expected of c.expected) {
				fakeRuntime.calledFunctions = [];
				clock.step(1000);

				const [, msg, err] = await puller.ensureImageExists(
					ctx,
					undefined,
					pod,
					container.image,
					c.pullSecrets ?? [],
					podSandboxConfig,
					"",
					container.imagePullPolicy,
				);

				fakeRuntime.assertCalls(expected.calls);
				expect(err?.name).toBe(expected.err?.name);
				expect(
					fakePodPullingTimeRecorder.startedPullingRecorded.get(pod.metadata?.uid ?? "") ?? false,
				).toBe(expected.shouldRecordStartedPullingTime);
				expect(
					fakePodPullingTimeRecorder.finishedPullingRecorded.get(pod.metadata?.uid ?? "") ?? false,
				).toBe(expected.shouldRecordFinishedPullingTime);
				expect(msg).toContain(expected.msg);
				fakePodPullingTimeRecorder.reset();
			}
		});
	}
});

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestApplyDefaultImageTag.
browser.describe("TestApplyDefaultImageTag", () => {
	const testCases = [
		{ testName: "root", input: "root", output: "root:latest" },
		{ testName: "root:tag", input: "root:tag", output: "root:tag" },
		{
			testName: "root@sha",
			input: "root@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			output: "root@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		},
		{
			testName: "root:latest@sha",
			input: "root:latest@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			output: "root:latest@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		},
		{ testName: "root:latest", input: "root:latest", output: "root:latest" },
	];

	for (const testCase of testCases) {
		it(testCase.testName, () => {
			const [image, err] = applyDefaultImageTag(testCase.input);
			expect(err).toBeUndefined();
			expect(image).toBe(testCase.output);
		});
	}
});

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestPullAndListImageWithPodAnnotations.
browser.describe("TestPullAndListImageWithPodAnnotations", () => {
	it("test pull and list image with pod annotations", async () => {
		const pod = {
			metadata: {
				name: "test_pod",
				namespace: "test-ns",
				uid: "bar",
				resourceVersion: "42",
				annotations: {
					"kubernetes.io/runtimehandler": "handler_name",
				},
			},
		} satisfies V1Pod;
		const podSandboxConfig = {
			metadata: {
				name: pod.metadata.name,
				namespace: pod.metadata.namespace,
				uid: pod.metadata.uid,
				attempt: 0,
			},
		};

		const c: PullerTestCase = {
			testName: "test pull and list image with pod annotations",
			containerImage: "missing_image",
			policy: "IfNotPresent",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [
				{
					calls: ["GetImageRef", "PullImage", "GetImageSize"],
					err: undefined,
					shouldRecordStartedPullingTime: true,
					shouldRecordFinishedPullingTime: true,
					events: [],
					msg: "",
				},
			],
		};

		const useSerializedEnv = true;
		const [puller, clock, fakeRuntime, container, fakePodPullingTimeRecorder] = pullerTestEnv(
			c,
			useSerializedEnv,
			undefined,
		);
		fakeRuntime.calledFunctions = [];
		fakeRuntime.imageList = [];
		clock.step(1000);

		const [, , err] = await puller.ensureImageExists(
			background(),
			undefined,
			pod,
			container.image,
			c.pullSecrets ?? [],
			podSandboxConfig,
			"",
			container.imagePullPolicy,
		);

		fakeRuntime.assertCalls(c.expected[0]?.calls ?? []);
		expect(err?.name).toBe(c.expected[0]?.err?.name);
		expect(fakePodPullingTimeRecorder.startedPullingRecorded.get(pod.metadata?.uid ?? "")).toBe(
			c.expected[0]?.shouldRecordStartedPullingTime,
		);
		expect(fakePodPullingTimeRecorder.finishedPullingRecorded.get(pod.metadata?.uid ?? "")).toBe(
			c.expected[0]?.shouldRecordFinishedPullingTime,
		);

		const [images] = await fakeRuntime.listImages(background());
		expect(images).toHaveLength(1);
		expect(images[0]?.id).toBe("missing_image:latest");
		expect(images[0]?.spec.runtimeHandler).toBe("");
		expect(images[0]?.spec.annotations).toEqual([
			{
				name: "kubernetes.io/runtimehandler",
				value: "handler_name",
			},
		]);
	});
});

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestMaxParallelImagePullsLimit.
browser.describe("TestMaxParallelImagePullsLimit", () => {
	it("limits concurrent pulls", async () => {
		const ctx = background();
		const pod = {
			metadata: {
				name: "test_pod",
				namespace: "test-ns",
				uid: "bar",
				resourceVersion: "42",
			},
		} satisfies V1Pod;
		const podSandboxConfig = {
			metadata: {
				name: pod.metadata.name,
				namespace: pod.metadata.namespace,
				uid: pod.metadata.uid,
				attempt: 0,
			},
		};

		const c: PullerTestCase = {
			containerImage: "present_image",
			testName: "image present, pull ",
			policy: "Always",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [],
		};
		const testCase = c;

		const useSerializedEnv = false;
		const maxParallelImagePulls = 5;
		const pulls: Array<Promise<unknown>> = [];

		const [puller, clock, fakeRuntime, container] = pullerTestEnv(
			testCase,
			useSerializedEnv,
			maxParallelImagePulls,
		);
		fakeRuntime.blockImagePulls = true;
		fakeRuntime.calledFunctions = [];
		clock.step(1000);

		for (let i = 0; i < maxParallelImagePulls; i++) {
			pulls.push(
				puller
					.ensureImageExists(
						ctx,
						undefined,
						pod,
						container.image,
						testCase.pullSecrets ?? [],
						podSandboxConfig,
						"",
						container.imagePullPolicy,
					)
					.then(([, , err]) => expect(err).toBeUndefined()),
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		fakeRuntime.assertCallCounts("PullImage", 5);

		for (let i = 0; i < 2; i++) {
			pulls.push(
				puller
					.ensureImageExists(
						ctx,
						undefined,
						pod,
						container.image,
						testCase.pullSecrets ?? [],
						podSandboxConfig,
						"",
						container.imagePullPolicy,
					)
					.then(([, , err]) => expect(err).toBeUndefined()),
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		fakeRuntime.assertCallCounts("PullImage", 5);

		fakeRuntime.unblockImagePulls(2);
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		fakeRuntime.assertCallCounts("PullImage", 7);

		fakeRuntime.unblockImagePulls(5);
		await Promise.all(pulls);
		fakeRuntime.assertCallCounts("PullImage", 7);
	});
});

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestParallelPodPullingTimeRecorderWithErr.
browser.describe("TestParallelPodPullingTimeRecorderWithErr", () => {
	it("finishes recorder state when a parallel pod pull errors after another pod succeeds", async () => {
		const ctx = background();
		const pod1 = {
			metadata: {
				name: "test_pod1",
				namespace: "test-ns",
				uid: "bar1",
				resourceVersion: "42",
			},
		} satisfies V1Pod;
		const pod1SandboxConfig = {
			metadata: {
				name: pod1.metadata.name,
				namespace: pod1.metadata.namespace,
				uid: pod1.metadata.uid,
				attempt: 0,
			},
		};

		const pod2 = {
			metadata: {
				name: "test_pod2",
				namespace: "test-ns",
				uid: "bar2",
				resourceVersion: "42",
			},
		} satisfies V1Pod;
		const pod2SandboxConfig = {
			metadata: {
				name: pod2.metadata.name,
				namespace: pod2.metadata.namespace,
				uid: pod2.metadata.uid,
				attempt: 0,
			},
		};

		const pods = [pod1, pod2];
		const podSandboxes = [pod1SandboxConfig, pod2SandboxConfig];

		const testCase: PullerTestCase = {
			containerImage: "missing_image",
			testName: "missing image, pull if not present",
			policy: "IfNotPresent",
			inspectErr: undefined,
			pullerErr: undefined,
			qps: 0.0,
			burst: 0,
			expected: [],
		};

		const useSerializedEnv = false;
		const maxParallelImagePulls = 2;
		const [imageManager, clock, fakeRuntime, container, fakePodPullingTimeRecorder] = pullerTestEnv(
			testCase,
			useSerializedEnv,
			maxParallelImagePulls,
		);
		fakeRuntime.blockImagePulls = true;
		fakeRuntime.calledFunctions = [];
		clock.step(1000);

		const pulls = pods.map((pod, i) =>
			imageManager.ensureImageExists(
				ctx,
				undefined,
				pod,
				container.image,
				testCase.pullSecrets ?? [],
				podSandboxes[i],
				"",
				container.imagePullPolicy,
			),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		fakeRuntime.assertCallCounts("PullImage", 2);
		expect(
			fakePodPullingTimeRecorder.startedPullingRecorded.get(pods[0]?.metadata?.uid ?? ""),
		).toBe(true);
		expect(
			fakePodPullingTimeRecorder.startedPullingRecorded.get(pods[1]?.metadata?.uid ?? ""),
		).toBe(true);
		expect(
			fakePodPullingTimeRecorder.finishedPullingRecorded.get(pods[0]?.metadata?.uid ?? "") ?? false,
		).toBe(false);
		expect(
			fakePodPullingTimeRecorder.finishedPullingRecorded.get(pods[1]?.metadata?.uid ?? "") ?? false,
		).toBe(false);

		fakeRuntime.unblockImagePulls(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		fakeRuntime.sendImagePullError(new Error("pull image error"));
		await Promise.all(pulls);

		const secondPulls: Array<Promise<unknown>> = [];
		for (let i = 0; i < 2; i++) {
			secondPulls.push(
				imageManager
					.ensureImageExists(
						ctx,
						undefined,
						pods[i],
						container.image,
						testCase.pullSecrets ?? [],
						podSandboxes[i],
						"",
						container.imagePullPolicy,
					)
					.then(([, , err]) => expect(err).toBeUndefined()),
			);
		}
		await Promise.all(secondPulls);

		fakeRuntime.assertCallCounts("PullImage", 2);
		expect(
			fakePodPullingTimeRecorder.finishedPullingRecorded.get(pods[0]?.metadata?.uid ?? ""),
		).toBe(true);
		expect(
			fakePodPullingTimeRecorder.finishedPullingRecorded.get(pods[1]?.metadata?.uid ?? ""),
		).toBe(true);
	});
});

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestEvalCRIPullErr.
browser.describe("TestEvalCRIPullErr", () => {
	const testCases = [
		{
			name: "fallback error",
			input: new Error("test"),
			assert: (msg: string, err: Error) => {
				expect(err.name).toBe("ErrImagePull");
				expect(msg).toContain("test");
			},
		},
		{
			name: "registry is unavailable",
			input: new Error("RegistryUnavailable"),
			assert: (msg: string, err: Error) => {
				expect(err.name).toBe("RegistryUnavailable");
				expect(msg).toBe("image pull failed for test because the registry is unavailable");
			},
		},
		{
			name: "registry is unavailable with additional error message",
			input: new Error("RegistryUnavailable: foo"),
			assert: (msg: string, err: Error) => {
				expect(err.name).toBe("RegistryUnavailable");
				expect(msg).toBe("image pull failed for test because the registry is unavailable: foo");
			},
		},
		{
			name: "signature is invalid",
			input: new Error("SignatureValidationFailed"),
			assert: (msg: string, err: Error) => {
				expect(err.name).toBe("SignatureValidationFailed");
				expect(msg).toBe("image pull failed for test because the signature validation failed");
			},
		},
		{
			name: "signature is invalid with additional error message (wrapped)",
			input: new Error("SignatureValidationFailed: bar"),
			assert: (msg: string, err: Error) => {
				expect(err.name).toBe("SignatureValidationFailed");
				expect(msg).toBe("image pull failed for test because the signature validation failed: bar");
			},
		},
	];

	for (const tc of testCases) {
		const testInput = tc.input;
		const testAssert = tc.assert;

		it(tc.name, () => {
			const [msg, err] = evalCRIPullErr("test", testInput);
			testAssert(msg, err);
		});
	}
});

// Models kubernetes/pkg/kubelet/images/image_manager_test.go TestImagePullPrecheck.
browser.describe("TestImagePullPrecheck", () => {
	const pod = {
		metadata: {
			name: "test_pod",
			namespace: "test-ns",
			uid: "bar",
			resourceVersion: "42",
		},
	} satisfies V1Pod;
	const podSandboxConfig = {
		metadata: {
			name: pod.metadata.name,
			namespace: pod.metadata.namespace,
			uid: pod.metadata.uid,
			attempt: 0,
		},
	};

	const cases = pullerTestCases();

	const useSerializedEnv = true;
	for (const c of cases) {
		it(c.testName, async () => {
			const ctx = background();
			const [puller, clock, fakeRuntime, container, , fakeRecorder] = pullerTestEnv(
				c,
				useSerializedEnv,
				undefined,
			);

			for (const expected of c.expected) {
				fakeRuntime.calledFunctions = [];
				for (;;) {
					const event = fakeRecorder.events?.tryReceive();
					if (!event?.ok) {
						break;
					}
				}
				clock.step(1000);

				const [, , err] = await puller.ensureImageExists(
					ctx,
					newObjectRef(),
					pod,
					container.image,
					c.pullSecrets ?? [],
					podSandboxConfig,
					"",
					container.imagePullPolicy,
				);

				fakeRuntime.assertCalls(expected.calls);
				const recorderEvents: string[] = [];
				for (;;) {
					const event = fakeRecorder.events?.tryReceive();
					if (!event?.ok) {
						break;
					}
					recorderEvents.push(event.value.split(" ")[1] ?? "");
				}
				expect(recorderEvents).toEqual(expected.events);
				expect(err?.name).toBe(expected.err?.name);
			}
		});
	}
});
