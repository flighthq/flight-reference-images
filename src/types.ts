export interface ArtifactLocator {
  artifactId: number;
  digest: string;
  repository: string;
  workflowRunId: number;
}

export interface CandidateCapture {
  error?: string;
  file?: string;
  identity: OracleIdentity;
  provenance?: CaptureProvenance;
  status: 'captured' | 'missing';
}

export interface CandidateLocator {
  $schema?: string;
  manifestSha256: string;
  preparedArtifact: ArtifactLocator;
  releaseTag: string;
  requestId: string;
  schemaVersion: 1;
  sourceArtifact: ArtifactLocator;
}

export interface CandidateManifest {
  $schema?: string;
  captures: CandidateCapture[];
  comparisonPolicyId: string;
  environmentId: string;
  requestId: string;
  schemaVersion: 1;
}

export interface CaptureProvenance {
  frames: number;
  sourceHash: string | null;
  targetKind: string | null;
  verifyPublished: boolean;
  warmupFrames: number;
}

export interface ComparisonPolicy {
  $schema?: string;
  calibration: {
    corpusSha256: string;
    flightCommit: string;
    independentHosts: number;
    notes: string;
    runsPerHost: number;
  };
  channelTolerance: number;
  environmentId: string;
  id: string;
  maximumChannelDelta: { mode: 'report' } | { maximum: number; mode: 'gate' };
  maximumMismatchFraction: number;
  schemaVersion: 1;
}

export interface DispatchEnvelope {
  artifactDigest: string;
  artifactId: number;
  flightCommit: string;
  repository: 'flighthq/flight';
  requestPath: string;
  requestSha256: string;
  schemaVersion: 1;
  workflowRunId: number;
}

export interface EnvironmentDescriptor {
  $schema?: string;
  browser: {
    name: string;
    playwrightVersion: string;
    version: string;
  };
  colorProfile: string;
  containerImage: string;
  devicePixelRatio: number;
  fonts: Array<{ family: string; sha256: string }>;
  id: string;
  locale: string;
  renderer: {
    arguments: string[];
    implementation: string;
  };
  schemaVersion: 1;
  timezone: string;
  viewport: { height: number; width: number };
}

export interface FlightOracleRequest {
  $schema?: string;
  frames: number;
  id: string;
  reason: string;
  schemaVersion: 1;
  subject: string;
  targets: Array<{ entry: string; renderers: string[] }>;
}

export interface ManifestPack {
  file: string;
  id: string;
  imageCount: number;
  sha256: string;
  size: number;
}

export interface OracleIdentity {
  entry: string;
  renderer: string;
  subject: string;
}

export interface OracleManifest {
  $schema?: string;
  packs: ManifestPack[];
  parentReleaseTag: string | null;
  releaseTag: string | null;
  schemaVersion: 1;
  sourceRequests: Array<{
    flightCommit: string;
    id: string;
    requestSha256: string;
  }>;
}

export interface OracleRecord {
  $schema?: string;
  artifactSha256: string;
  colorSpace: 'srgb';
  comparisonPolicyId: string;
  environmentId: string;
  flightCommit: string;
  height: number;
  identity: OracleIdentity;
  pack: string;
  pixelFormat: 'rgba8';
  pixelSha256: string;
  provenance: CaptureProvenance;
  request: {
    id: string;
    sha256: string;
  };
  schemaVersion: 1;
  width: number;
}

export interface PackConfiguration {
  $schema?: string;
  schemaVersion: 1;
  subjects: Record<
    string,
    {
      defaultPack: string;
      rules?: Array<{ entryPattern: string; pack: string }>;
    }
  >;
}
