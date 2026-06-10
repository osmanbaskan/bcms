/**
 * Capture Faz 0 unit testleri — AĞ YOK (canlı Capture'a kesinlikle dokunulmaz).
 * Kapsam: env config parse + WSDL operasyon çıkarımı + read/write sınıflama.
 */
import { describe, it, expect } from 'vitest';
import { loadCaptureEnvConfig } from './capture.config.js';
import { classifyOperation, extractWsdlOperations, parseHostPort } from './capture.client.js';

describe('capture.config — env parse (default GÜVENLİ/KAPALI)', () => {
  it('boş env → bağlantı kapalı, yazma kapalı, timeout 10s, poll 60s', () => {
    const cfg = loadCaptureEnvConfig({} as NodeJS.ProcessEnv);
    expect(cfg.connectionEnabled).toBe(false);
    expect(cfg.writeEnabled).toBe(false);
    expect(cfg.wsUrl).toBeNull();
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.pollSeconds).toBe(60);
  });
  it('env yazma anahtarını AÇAMAZ (yalnız DB/UI)', () => {
    const cfg = loadCaptureEnvConfig({ CAPTURE_WS_ENABLED: 'true', CAPTURE_WRITE_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.connectionEnabled).toBe(true);
    expect(cfg.writeEnabled).toBe(false); // kesin kural
  });
  it('geçersiz sayılar fallback alır', () => {
    const cfg = loadCaptureEnvConfig({ CAPTURE_WS_TIMEOUT_MS: 'abc', CAPTURE_WS_POLL_SECONDS: '-5' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.pollSeconds).toBe(60);
  });
});

describe('classifyOperation — read/write sınıflama (güvenli taraf: bilinmeyen=write)', () => {
  it.each([
    ['getRecordings', 'read'], ['listChannels', 'read'], ['queryStatus', 'read'],
    ['subscribeNotifications', 'read'], ['ping', 'read'],
  ])('%s → %s', (name, kind) => expect(classifyOperation(name)).toBe(kind));
  it.each([
    ['createRecording', 'write'], ['deleteRecording', 'write'], ['updateRecording', 'write'],
    ['modifySchedule', 'write'], ['cancelRecording', 'write'], ['startCapture', 'write'],
    ['stopCapture', 'write'], ['scheduleRecording', 'write'],
  ])('%s → %s (YASAK sınıf)', (name, kind) => expect(classifyOperation(name)).toBe(kind));
  it('bilinmeyen isim → write (varsayılan tehlikeli, dokunulmaz)', () => {
    expect(classifyOperation('frobnicate')).toBe('write');
  });
});

describe('extractWsdlOperations — WSDL parse (fixture, ağ yok)', () => {
  const WSDL = `<?xml version="1.0"?>
    <wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
      <wsdl:portType name="ScheduleClient">
        <wsdl:operation name="getRecordings"><wsdl:input/></wsdl:operation>
        <wsdl:operation name="createRecording"><wsdl:input/></wsdl:operation>
        <wsdl:operation name="listChannels"><wsdl:input/></wsdl:operation>
      </wsdl:portType>
      <wsdl:binding><wsdl:operation name="getRecordings"/></wsdl:binding>
    </wsdl:definitions>`;
  it('operasyonları tekilleştirip sınıflar', () => {
    const ops = extractWsdlOperations(WSDL);
    expect(ops).toEqual([
      { name: 'createRecording', kind: 'write' },
      { name: 'getRecordings', kind: 'read' },
      { name: 'listChannels', kind: 'read' },
    ]);
  });
  it('boş/operasyonsuz XML → []', () => {
    expect(extractWsdlOperations('<x/>')).toEqual([]);
  });
});

describe('parseHostPort', () => {
  it('explicit port', () => expect(parseHostPort('http://10.0.0.5:8080/ScheduleClient')).toEqual({ host: '10.0.0.5', port: 8080 }));
  it('http default 80', () => expect(parseHostPort('http://cap-host/ScheduleClient')).toEqual({ host: 'cap-host', port: 80 }));
  it('https default 443', () => expect(parseHostPort('https://cap-host/x')).toEqual({ host: 'cap-host', port: 443 }));
});
