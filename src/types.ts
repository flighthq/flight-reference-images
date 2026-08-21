export interface ArtifactLocator {
  artifactId: number;
  digest: string;
  repository: string;
  workflowRunId: number;
}

export interface CandidateApproval {
  $schema?: string;
  baseRecords: Array<{ path: string; sha256: string | null }>;
  candidateSha256: string;
  flightCommit: string;
  preparedArtifact: ArtifactLocator;
  records: Array<{ path: string; sha256: string }>;
  requestId: string;
  requestSha256: string;
  schemaVersion: 1;
  sourceArtifact: ArtifactLocator;
}

export interface CandidateCapture {
  error?: string;
  file?: string;
  identity: OracleIdentity;
  provenance?: CaptureProvenance;
  status: 'captured' | 'missing';
}

export interface BatchDispatchEnvelope {
  candidates: Array<{
    artifactDigest: string;
    artifactId: number;
    requestPath: `reference-image-requests/${string}.json`;
    requestSha256: string;
  }>;
  flightCommit: string;
  repository: 'flighthq/flight';
  schemaVersion: 2;
  workflowRunId: number;
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

export interface BatchLocator {
  $schema?: string;
  manifestSha256: string;
  preparedArtifact: ArtifactLocator;
  releaseTag: string;
  requestIds: string[];
  schemaVersion: 2;
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
  flightCommittedAt?: string;
  repository: 'flighthq/flight';
  requestPath: `reference-image-requests/${string}.json`;
  requestSha256: string;
  schemaVersion: 1;
  workflowRunId: number;
}

export interface IntakePolicy {
  $schema?: string;
  candidateArtifactRetentionDays: number;
  maximumFutureSkewMinutes: number;
  maximumImageBytes: number;
  maximumImageHeight: number;
  maximumImagePixels: number;
  maximumImageWidth: number;
  maximumRequestAgeHours: number;
  schemaVersion: 1;
}

export interface EnvironmentDescriptor {
  $schema?: string;
  browser: {
    name: string;
    playwrightVersion: string;
    revision: string;
    version: string;
  };
  colorProfile: string;
  devicePixelRatio: number;
  execution: { image: string; kind: 'container' } | { architecture: string; kind: 'native'; maximumVectorIsa: string };
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
  createdAt?: string;
  frames: number;
  id: string;
  reason: string;
  schemaVersion: 3;
  subject: string;
  targets: Array<{
    build: {
      commit: string;
      dirty: string[];
      dirtyOmitted: number;
    };
    capture: {
      environmentId: string;
      hostInstanceId: string;
    };
    entry: string;
    pixelSha256: string;
    renderer: string;
  }>;
}

export interface RequestImageDifferences {
  differences: Array<{
    capturedPixelSha256: string;
    identity: OracleIdentity;
    requestedPixelSha256: string;
  }>;
  requestId: string;
  schemaVersion: 1;
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

export interface ReferenceImageLock {
  $schema?: string;
  manifestSha256: string;
  oracleCommit: string;
  packs: Record<
    string,
    {
      file: string;
      images: Record<string, { pixelSha256: string }>;
      sha256: string;
    }
  >;
  releaseTag: string;
  repository: 'flighthq/flight-reference-images';
  schemaVersion: 2;
}

export interface PackImage {
  artifactSha256: string;
  height: number;
  path: string;
  pixelSha256: string;
  width: number;
}

export interface PackManifest {
  images: PackImage[];
  pack: string;
  schemaVersion: 1;
}

export interface PreparedIntake {
  baseManifestSha256: string;
  baseRecordsSha256: string;
  candidateSha256: string;
  envelopeSha256: string;
  expectedManifestSha256: string;
  packs: ManifestPack[];
  records: Array<{ path: string; sha256: string }>;
  releaseTag: string;
  requestSha256: string;
  schemaVersion: 1;
}

export interface PreparedBatch {
  approvalSha256s: Array<{ requestId: string; sha256: string }>;
  baseManifestSha256: string;
  baseRecordsSha256: string;
  expectedManifestSha256: string;
  packs: ManifestPack[];
  records: Array<{ path: string; sha256: string }>;
  releaseTag: string;
  requestIds: string[];
  schemaVersion: 1;
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
