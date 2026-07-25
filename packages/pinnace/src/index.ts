/**
 * pinnace library core — the public TypeScript API.
 *
 * All logic lives in the core (see CONTEXT.md `core vs cli`); the `pinnace`
 * CLI bin (src/cli/bin.ts) is a thin wrapper that imports from here, so every
 * operation is equally usable as a TypeScript API. Subsequent tracer-bullet
 * tasks (Kubo RPC client, CAR build, key derivation, cloud-init, CI emitter,
 * status, config, deploy, site management, CLI) hang off this entrypoint.
 */

/** The package name, exposed so the CLI and API can report a consistent identity. */
export const PINNACE = 'pinnace';

/** Returns the pinnace package name (a trivial seam proving the toolchain is wired). */
export function name(): string {
	return PINNACE;
}

export {
	KuboRpcClient,
	KuboRpcError,
	type KuboRpcClientOptions,
	type FetchLike,
	type FilesMkdirOptions,
	type FilesRmOptions,
	type PinAddOptions,
	type NamePublishOptions,
} from './rpc/kubo-rpc-client.js';
export {
	MockKuboApi,
	type RecordedRequest,
	type MockResponseSpec,
} from './rpc/mock-kubo.js';
export {buildCar, writeCar, type BuiltCar} from './car/car-build.js';
export {
	deriveIpnsKey,
	deriveIpnsId,
	IPNS_INFO_PREFIX,
	type Master,
	type DeriveIpnsInput,
	type DerivedIpnsKey,
} from './derive/ipns-key-derivation.js';
export {
	resolveConfig,
	resolveMasterSecret,
	resolveHostToken,
	hostTokenEnvVar,
	MissingHostTokenError,
	type PinnaceConfigFile,
	type ResolvedConfig,
	type HostConfig,
	type SiteConfig,
	type HostRole,
	type SiteMode,
	type EnvRecord,
	type CliOverrides,
	type ResolveConfigInput,
	type ResolveMasterInput,
	type ResolveHostTokenInput,
} from './config/config-resolution.js';
export {
	emitCi,
	githubCiProvider,
	CI_SYSTEMS,
	type CiSystem,
	type CIProvider,
	type EmitCiInput,
	type EmittedCi,
	type EmittedFile,
	type RequiredCiSetting,
} from './ci/ci-emit.js';
export {
	provision,
	hetznerHostProvider,
	HOST_PROVIDERS,
	type HostName,
	type HostProvider,
	type ProvisionInput,
	type ProvisionResult,
} from './provision/cloud-init.js';
export {
	serializeIpnsKeyForImport,
	importIpnsKeyIntoPublisher,
	KeyImportRoleError,
	LIBP2P_ED25519_PRIVATE_KEY_PREFIX,
	type ImportIpnsKeyInput,
	type KeyImportResult,
} from './publisher/key-import.js';
export {
	lookupIpnsKeyId,
	publishSiteRecord,
	type PublishSiteRecordInput,
} from './publisher/ipns-publish.js';
export {
	republishAndExport,
	mirrorAndReannounce,
	makeRepublishOp,
	makeMirrorOp,
	promoteReplicaToPublisher,
	RECORD_LIFETIME,
	RECORD_TTL,
	type PromoteReplicaInput,
	type PromoteReplicaResult,
} from './publisher/record-sequence.js';
export {
	runNodeCommand,
	discoverSites,
	NODE_VERBS,
	type NodeVerb,
	type NodeCommandContext,
	type NodeCommandOps,
	type NodeCommandResult,
	type NodeOpResult,
	type DiscoveredSite,
	type SiteOutcome,
	type PublisherFetch,
	type GatewayFetch,
} from './node/node-commands.js';
export {
	siteWrapperPath,
	siteContentPath,
	siteMetadataPath,
	encodeSiteMetadata,
	parseSiteMetadata,
	readSiteMetadata,
	SITE_CONTENT_ENTRY,
	SITE_METADATA_ENTRY,
	type SiteMetadata,
} from './site/site-wrapper.js';
export {
	listSites,
	removeSite,
	addSite,
	placeInMfs,
	SITE_VERBS,
	type SiteVerb,
	type SiteListing,
	type ListSitesInput,
	type RemoveSiteInput,
	type RemoveSiteResult,
	type AddSiteInput,
	type AddSiteResult,
} from './site/site-management.js';
export {
	deploy,
	type DeployInput,
	type DeployTarget,
	type DeployResult,
	type DeployNodeOk,
	type DeployNodeFailure,
} from './deploy/deploy.js';
export {
	pinExternal,
	PinStageError,
	PinPublisherRequiredError,
	PinSourceResolveError,
	type PinExternalInput,
	type PinExternalResult,
	type PinTarget,
	type PinStage,
	type PinNodeOk,
	type PinNodeFailure,
} from './pin/pin-external.js';
export {
	statusReport,
	makeStatusOp,
	defaultProvidersLookup,
	defaultGatewayProbe,
	type StatusReport,
	type SiteStatus,
	type StatusReportInput,
	type ProvidersLookup,
	type ProvidersResponse,
	type GatewayProbe,
} from './status/status-report.js';
export {
	renderStatusHtml,
	DEFAULT_STATUS_REFRESH_SECONDS,
	type StatusPageReport,
	type StatusPageSite,
	type RenderStatusHtmlOptions,
} from './status/status-html.js';
