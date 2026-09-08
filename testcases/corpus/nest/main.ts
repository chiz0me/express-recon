import { Controller, Get, Module, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

class DenyGuard {
  canActivate() {
    return false;
  }
}

@Controller("status")
class StatusController {
  @Get("health")
  health() {
    return { ok: true };
  }

  @Get("secure")
  @UseGuards(DenyGuard)
  secure() {
    return { secret: true };
  }
}

@Module({ controllers: [StatusController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  await app.listen(3000);
}

bootstrap();
