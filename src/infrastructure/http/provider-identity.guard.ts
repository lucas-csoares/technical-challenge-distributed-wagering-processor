import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * Ponto de extensão da identidade do provedor.
 *
 * A autenticação foi deliberadamente omitida desta entrega — a decisão e o
 * desenho que seria adotado estão em ARCHITECTURE.md. O guard existe para que
 * essa omissão tenha um lugar **nomeado** no código: instalar um verificador
 * OIDC de verdade é substituir o corpo deste método, e não espalhar checagens
 * pelos controllers ou, pior, dentro das regras financeiras.
 *
 * Ele cobre apenas os endpoints financeiros. Health e métricas continuam
 * públicos por decisão registrada, então não recebem guard nenhum — e assim
 * ligar a autenticação aqui não os quebra por acidente.
 *
 * A identidade do provedor contida no payload continua sujeita às validações de
 * domínio, independentemente deste guard: autenticar quem chama não é o mesmo
 * que confiar no que foi enviado.
 */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
