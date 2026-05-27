// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go ListOptions.
export interface ListOptions {
	labelSelector?: string;
	fieldSelector?: string;
	watch?: boolean;
	resourceVersion?: string;
	timeoutSeconds?: number;
	allowWatchBookmarks?: boolean;
}
