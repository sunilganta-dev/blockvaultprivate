import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { connect, type Identity, type Signer, signers } from "@hyperledger/fabric-gateway";

export type FabricClient = {
  submit: (fn: string, args: string[]) => Promise<Uint8Array>;
  evaluate: (fn: string, args: string[]) => Promise<Uint8Array>;
  close: () => void;
};

function readFirstFile(dir: string): string {
  if (!fs.existsSync(dir)) {
    throw new Error(`Directory not found: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .sort(); // deterministic
  if (files.length === 0) {
    throw new Error(`No files found in directory: ${dir}`);
  }
  return path.join(dir, files[0]);
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function newFabricClient(env: Record<string, string | undefined>): Promise<FabricClient> {
  const FABRIC_SAMPLES = env.FABRIC_SAMPLES;
  if (!FABRIC_SAMPLES) {
    throw new Error("FABRIC_SAMPLES is required in .env (path to fabric-samples)");
  }

  const CHANNEL_NAME = env.CHANNEL_NAME || "mychannel";
  const CHAINCODE_NAME = env.CHAINCODE_NAME || "incident";

  const PEER_ENDPOINT = env.PEER_ENDPOINT || "localhost:7051";
  const PEER_HOST_ALIAS = env.PEER_HOST_ALIAS || "peer0.org1.example.com";

  // Test-network crypto material paths (Org1 User1)
  const org1Base = path.join(
    FABRIC_SAMPLES,
    "test-network",
    "organizations",
    "peerOrganizations",
    "org1.example.com"
  );

  const userMspDir = path.join(org1Base, "users", "User1@org1.example.com", "msp");

  // IMPORTANT: signcert file is not always named cert.pem in test-network;
  // read the first file in signcerts directory.
  const certDir = path.join(userMspDir, "signcerts");
  const certPath = readFirstFile(certDir);

  // keystore contains a single private key file with a generated name
  const keyDir = path.join(userMspDir, "keystore");
  const keyPath = readFirstFile(keyDir);

  // TLS cert for peer0.org1
  const tlsCertPath = path.join(org1Base, "peers", "peer0.org1.example.com", "tls", "ca.crt");
  if (!fs.existsSync(tlsCertPath)) {
    throw new Error(`TLS CA cert not found: ${tlsCertPath}`);
  }

  const tlsRootCert = fs.readFileSync(tlsCertPath);

  // gRPC connection to peer
  const grpcClient = new grpc.Client(
    PEER_ENDPOINT,
    grpc.credentials.createSsl(tlsRootCert),
    {
      // Required when using localhost + TLS with Fabric test-network cert hostnames
      "grpc.ssl_target_name_override": PEER_HOST_ALIAS,
      "grpc.default_authority": PEER_HOST_ALIAS
    }
  );

  const identity: Identity = {
    mspId: "Org1MSP",
    credentials: fs.readFileSync(certPath)
  };

  const privateKeyPem = fs.readFileSync(keyPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signer: Signer = signers.newPrivateKeySigner(privateKey);

  const gateway = connect({
    client: grpcClient,
    identity,
    signer
  });

  const network = gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);

  return {
    submit: async (fn, args) => contract.submitTransaction(fn, ...args),
    evaluate: async (fn, args) => contract.evaluateTransaction(fn, ...args),
    close: () => {
      gateway.close();
      grpcClient.close();
    }
  };
}
