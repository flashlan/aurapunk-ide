import { useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { QrCodeIcon } from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal, type NoProps } from '@/shared/lib/modals';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';

type PairingResponse = {
  data?: {
    pairing_url: string;
    endpoint: string;
    endpoints?: string[];
    expires_at: number;
  };
  message?: string;
};

type LanServerInfo = {
  port: number;
  endpoints: string[];
};

const LocalMobilePairingDialogImpl = create<NoProps>(() => {
  const modal = useModal();
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const generateInvite = async () => {
    setPending(true);
    setError(null);
    try {
      let endpoints: string[];
      if ('__TAURI_INTERNALS__' in window) {
        const info = await invoke<LanServerInfo>('start_lan_server');
        endpoints = info.endpoints;
      } else {
        const currentUrl = new URL(window.location.origin);
        const loopbackHosts = new Set([
          'localhost',
          '127.0.0.1',
          '::1',
          '[::1]',
        ]);
        endpoints = loopbackHosts.has(currentUrl.hostname)
          ? []
          : [currentUrl.origin];
      }

      if (endpoints.length === 0) {
        throw new Error(
          'Não foi possível detectar uma interface de rede local. Abra o Desktop pela rede local e tente novamente.'
        );
      }

      const response = await makeLocalApiRequest('/api/mobile/pairing/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoints }),
      });
      const body = (await response.json()) as PairingResponse;
      if (!response.ok || !body.data?.pairing_url) {
        throw new Error(
          body.message ?? `Desktop retornou HTTP ${response.status}`
        );
      }
      setPairingUrl(body.data.pairing_url);
    } catch (inviteError) {
      setError(
        inviteError instanceof Error
          ? inviteError.message
          : 'Não foi possível criar o convite local.'
      );
    } finally {
      setPending(false);
    }
  };

  const close = () => {
    modal.hide();
    modal.remove();
  };

  return (
    <Dialog open={modal.visible} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCodeIcon className="size-icon-sm text-brand" weight="bold" />
            Conectar AuraPunk Mobile pela rede local
          </DialogTitle>
          <DialogDescription className="space-y-3 text-left">
            <span className="block">
              O QR é temporário e pode ser usado uma única vez. O token
              permanente do Desktop não é colocado no QR.
            </span>
            <span className="block text-xs text-low">
              Ao usar o aplicativo empacotado, o listener LAN é iniciado
              automaticamente neste botão e encerrado quando o Desktop fecha. Em
              desenvolvimento web, inicie o backend com HOST=0.0.0.0.
            </span>
          </DialogDescription>
        </DialogHeader>

        {!pairingUrl ? (
          <div className="space-y-3 text-sm text-normal">
            <p>
              O Desktop inicia o listener local e detecta automaticamente as
              interfaces disponíveis — Wi-Fi, Ethernet e redes privadas como
              WireGuard/Tailscale.
            </p>
            <p className="text-xs text-low">
              Você só precisa gerar o QR code e escaneá-lo no AuraPunk Mobile.
            </p>
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-md bg-white p-4">
              <QRCodeSVG
                value={pairingUrl}
                size={240}
                level="M"
                includeMargin
              />
            </div>
            <p className="text-center text-sm text-normal">
              Abra AuraPunk Mobile, escolha <strong>Conectar Desktop</strong> e
              escaneie este código em até 2 minutos.
            </p>
            <button
              type="button"
              className="max-w-full break-all text-center text-xs text-low hover:text-normal"
              onClick={() => navigator.clipboard?.writeText(pairingUrl)}
              title="Copiar convite"
            >
              {pairingUrl}
            </button>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={close}>
            Fechar
          </Button>
          {!pairingUrl ? (
            <Button onClick={() => void generateInvite()} disabled={pending}>
              {pending ? 'Gerando…' : 'Gerar QR code'}
            </Button>
          ) : (
            <Button onClick={() => setPairingUrl(null)}>Gerar outro</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const LocalMobilePairingDialog = defineModal<NoProps, void>(
  LocalMobilePairingDialogImpl
);
