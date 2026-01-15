"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fabric_shim_1 = require("fabric-shim");
const incidentContract_1 = require("./incidentContract");
const server = new fabric_shim_1.ChaincodeServer({
    ccid: process.env.CHAINCODE_ID ?? "incident",
    address: process.env.CHAINCODE_SERVER_ADDRESS ?? "0.0.0.0:9999",
    tlsProps: undefined,
    contract: new incidentContract_1.IncidentContract()
});
server.start();
