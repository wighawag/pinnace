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
