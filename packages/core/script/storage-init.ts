import { CentralStorage } from "../src/storage/central"

const config = CentralStorage.current()
if (!config) throw new Error("Storage initialization requires OPENCODE_STORAGE_MODE=central")
await CentralStorage.provision(config)
console.log(`Verified central storage ${config.id} at ${config.root}`)
