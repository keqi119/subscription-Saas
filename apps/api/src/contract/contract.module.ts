import { Module } from "@nestjs/common";

import { StorageModule } from "../storage/storage.module";
import { ContractPdfArtifactWriterService } from "./contract-pdf-artifact-writer.service";
import { ContractPdfRendererService } from "./contract-pdf-renderer.service";

@Module({
  exports: [ContractPdfArtifactWriterService, ContractPdfRendererService],
  imports: [StorageModule],
  providers: [ContractPdfArtifactWriterService, ContractPdfRendererService]
})
export class ContractModule {}
