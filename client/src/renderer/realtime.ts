import type { Api } from './api';

type Status = 'online' | 'connecting' | 'offline';

export class Realtime {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private timer: number | undefined;
  private watchdog: number | undefined;

  constructor(
    private api: Api,
    private onEvent: (ev: { type: string; data: unknown }) => void,
    private onStatus: (s: Status) => void,
  ) {}

  connect() {
    if (this.closed) return;
    this.onStatus(this.attempt === 0 ? 'connecting' : 'offline');
    const url = this.api.base.replace(/^http/, 'ws') + '/api/v1/ws';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.api.token }));
    };
    ws.onmessage = (e) => {
      let ev: { type: string; data: unknown };
      try {
        ev = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (ev.type === 'hello') {
        this.attempt = 0;
        this.onStatus('online');
      }
      this.kick();
      if (ev.type !== 'ping') this.onEvent(ev);
    };
    ws.onclose = (e) => {
      window.clearTimeout(this.watchdog);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      if (e.code === 4001) {
        this.onStatus('offline');
        window.dispatchEvent(new CustomEvent('tolktak:unauthorized'));
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  // The server pings every 25 s. 70 s of silence means a half-open socket.
  private kick() {
    window.clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => {
      // No closing handshake on a dead socket.
      const dead = this.ws;
      this.ws = null;
      dead?.close();
      this.scheduleReconnect();
    }, 70000);
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.onStatus('offline');
    const delay = Math.min(30000, 500 * 2 ** this.attempt) * (0.7 + Math.random() * 0.6);
    this.attempt++;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  nudge() {
    if (!this.ws && !this.closed) {
      window.clearTimeout(this.timer);
      this.attempt = 0;
      this.connect();
    }
  }

  send(frame: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.watchdog);
    this.ws?.close();
  }
}
