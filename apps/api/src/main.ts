import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";

import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);
  const bodyLimit = config.get<string>("API_JSON_BODY_LIMIT") ?? "5mb";
  const corsOrigin = config.get<string>("CORS_ORIGIN") ?? "http://localhost:3000";
  const port = config.get<number>("PORT") ?? 3001;

  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  app.useBodyParser("json", { limit: bodyLimit });
  app.useBodyParser("urlencoded", { extended: true, limit: bodyLimit });
  app.use(cookieParser());
  app.enableCors({
    credentials: true,
    origin: corsOrigin.split(",").map((origin) => origin.trim())
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true
    })
  );

  await app.listen(port);
}

void bootstrap();
