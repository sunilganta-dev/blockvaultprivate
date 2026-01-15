import { ChaincodeServer } from "fabric-shim";
import { IncidentContract } from "./incidentContract";

const server = new ChaincodeServer({
  ccid: process.env.CHAINCODE_ID ?? "incident",
  address: process.env.CHAINCODE_SERVER_ADDRESS ?? "0.0.0.0:9999",
  tlsProps: undefined,
  contract: new IncidentContract()
});

server.start();
