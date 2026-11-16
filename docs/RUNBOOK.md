# Runbook Operacional - CellDiag Telemetry

Guia prático e passo a passo para operação, conexão SSH, execução de diagnósticos e resolução de problemas no ambiente de telemetria celular (Samsung Galaxy S10 / Android 12 Root).

---

## 1. Conexão e Acesso ao Dispositivo

### 1.1. Pré-requisitos
* Aparelho conectado ao computador via cabo USB com Depuração USB ativada.
* Binário do ADB disponível no Windows em:
  `C:\Users\ferrba\Documents\scrcpy-win64-v3.3.1\scrcpy-win64-v3.3.1\adb.exe`
* Dispositivo identificado: `RX8M704KWLW` (Samsung Galaxy S10 - SM-G973F / beyond1).

---

### 1.2. Passo a Passo: Conexão SSH via Tabby

O Termux possui um servidor OpenSSH nativo configurado na porta `8022`. Para acessar o terminal do celular diretamente pelo **Tabby** no Windows através do cabo USB:

#### Passo 1: Encaminhar a porta via ADB
No PowerShell do Windows, execute o redirecionamento de porta:
```powershell
& "C:\Users\ferrba\Documents\scrcpy-win64-v3.3.1\scrcpy-win64-v3.3.1\adb.exe" forward tcp:8022 tcp:8022
```
*(Esse comando faz o Windows apontar a porta local `8022` direto para a porta `8022` do Termux no celular).*

#### Passo 2: Configurar o Perfil no Tabby
1. Abra o **Tabby**.
2. Vá em **Settings (Configurações)** > **Profiles & connections (Perfis e conexões)**.
3. Clique em **New Profile (Novo Perfil)** e selecione **SSH connection**.
4. Preencha os campos com as seguintes configurações:
   * **Profile Name**: `Galaxy S10 - Termux`
   * **Host**: `127.0.0.1` (ou `localhost`)
   * **Port**: `8022`
   * **Username**: `u0_a290`
   * **Password**: A senha definida no Termux (se solicitada, defina no Termux digitando `passwd`).
5. Clique em **Save** e em seguida conecte-se.

#### Passo 3: Garantir que o servidor SSH esteja ativo no celular
Caso o celular seja reiniciado e o Tabby não consiga conectar, o serviço SSH pode estar parado. Para iniciá-lo:
* **Pelo Termux no celular**: abra o app e digite:
  ```bash
  sshd
  ```
* **Ou direto pelo Windows via ADB**:
  ```powershell
  & "C:\Users\ferrba\Documents\scrcpy-win64-v3.3.1\scrcpy-win64-v3.3.1\adb.exe" shell "su -c 'su u0_a290 -c /data/data/com.termux/files/usr/bin/sshd'"
  ```

---

## 2. Guia de Comandos e Operação

Os scripts foram desenvolvidos sem emojis para máxima compatibilidade e limpos visualmente.

### 2.1. `rfdiag` (ou `rfdiag.sh` / `celldiag`)
Ferramenta principal de engenharia de RF e telemetria celular em tempo real.

| Comando | Descrição |
| :--- | :--- |
| `rfdiag` | Exibe o dashboard completo instantaneamente e grava log em `/sdcard/logs/`. |
| `rfdiag -w 2` | **Modo Analisador ao Vivo**: atualiza a tela a cada 2 segundos continuamente. |
| `rfdiag -n` | **Apenas Células Vizinhas**: exibe unicamente a tabela com o escaneamento das antenas ao redor. |
| `rfdiag -l /sdcard/logs/drive.csv` | **Modo Drive Test**: registra continuamente em CSV a telemetria (RSRP, TA, GPS, Ping, Throughput). |
| `rfdiag -j` | **Exportação JSON**: retorna todas as métricas estruturadas para scripts ou bots. |
| `rfdiag -p` | Pausa no final aguardando ENTER (ideal para widgets de tela). |

#### O que o `rfdiag` analisa:
* **Serving Cell**: Tecnologia (LTE / LTE_CA 4.5G), Operadora, APN, RSRP (dBm), RSRQ (dB), RSSNR (dB), Banda/Frequência (ex: B28 700MHz), PCI, TAC, eNodeB/CI, CQI e modulação (16QAM/64QAM/256QAM).
* **Timing Advance (TA)**: Distância física calculada até a torre em metros ($\text{Distância} = TA \times 78{,}12\text{m}$).
* **Throughput Real**: Download e Upload em KB/s via kernel (`rmnet0`) e volume acumulado da sessão em MB.
* **Latência**: Ping ativo e perda de pacotes na interface móvel.
* **Georreferenciamento Multi-Provedor**:
  1. *GPS Nativo (GNSS)*: Satélites de alta precisão (quando fixado).
  2. *Triangulação Celular*: Torre conectada e distância TA.
  3. *GeoIP*: Localização regional por rota da operadora.
* **Hardware & Térmica**: Nível de bateria %, temperatura interna (°C) e voltagem real (V).
* **Scanner de Vizinhas**: Tabela com todas as antenas secundárias detectadas ao redor.

---

### 2.2. `siminfo` (ou `sim_info.sh`)
Diagnóstico detalhado de identidade do SIM Card, dispositivo e rede local.

| Comando | Descrição |
| :--- | :--- |
| `siminfo` | Diagnóstico completo do chip e configurações de rede. |
| `siminfo -w 3` | Monitoramento contínuo a cada 3 segundos. |
| `siminfo -s` | Apenas resumo de sinal e antenas. |
| `siminfo -H` | Exibe o histórico de SIM Cards registrados no banco interno de telefonia. |
| `siminfo -j` | Saída em JSON estruturado. |

#### O que o `siminfo` analisa:
* **Dispositivo**: Fabricante, Modelo, Codename, Android, API e Serial físico.
* **Identificação do Chip**: Slot, Operadora/MVNO (VirtuEyes), ICCID, IMSI, PLMN (MCC/MNC: 724/40).
* **Conexão & Roteamento**: Tecnologia (LTE_CA), APN (`virtueyes.com.br`), IP Móvel CGNAT (`100.111.224.41/24`), Gateway (`100.111.224.1`), IP Público e DNS (`8.8.8.8`).

---

## 3. Gestão dos Arquivos de Log

A cada execução do `rfdiag` ou do `siminfo`, um relatório de texto puro (`.txt`) sem códigos de escape ANSI é salvo automaticamente.

### 3.1. Localização dos Arquivos
* **Caminho no Android**: `/sdcard/logs/` (raiz do Armazenamento Interno do celular).
* **Atalho no Termux**: `~/logs_sdcard/` (basta digitar `cd ~/logs_sdcard`).

### 3.2. Como Acessar e Copiar os Logs para o PC
1. **Via Windows Explorer**:
   Conecte o celular via USB, abra "Este Computador" > "Galaxy S10" > "Armazenamento Interno" > pasta "logs".
2. **Via ADB no PowerShell**:
   Para baixar todos os logs de uma só vez para o seu PC:
   ```powershell
   & "C:\Users\ferrba\Documents\scrcpy-win64-v3.3.1\scrcpy-win64-v3.3.1\adb.exe" pull /sdcard/logs/ "C:\Users\ferrba\Downloads\logs_celular\"
   ```

---

## 4. Atalhos na Tela Inicial do Celular (Termux:Widget)

Para disparar os diagnósticos com apenas 1 toque na tela do celular sem precisar abrir o terminal:
1. Mantenha o dedo pressionado em um espaço vazio da tela inicial do celular.
2. Selecione **Widgets** > **Termux:Widget**.
3. Escolha o atalho:
   * `rfdiag.sh`: Dispara o diagnóstico de rádio e pausa com os dados na tela.
   * `sim_info.sh`: Dispara a leitura do SIM Card e rede.

---

## 5. Resolução de Problemas (Troubleshooting)

### A. `rfdiag.sh: command not found`
* **Causa**: O comando foi digitado antes de recarregar a tabela do bash.
* **Solução**: Execute `source ~/.bashrc` ou digite apenas `rfdiag`.

### B. `ssh: connect to host localhost port 8022: Connection refused`
* **Causa**: O encaminhamento de porta do ADB não foi feito ou o `sshd` parou.
* **Solução**:
  1. No Windows: `adb forward tcp:8022 tcp:8022`
  2. No Termux: digite `sshd`

### C. `Latência RTT (Ping) : 0 ms (Perda: 100%)`
* **Causa**: O comando `ping` foi chamado sem permissão de root para bind na interface `rmnet0`.
* **Solução**: Já corrigido na versão atual do `rfdiag`, que eleva automaticamente para root para bind com `CAP_NET_RAW`.

### D. GPS exibindo "Aguardando visada de satélites"
* **Causa**: O aparelho está em ambiente fechado (cobertura interna).
* **Comportamento normal**: O GPS (satélites) requer visada aberta para o céu. Enquanto estiver em ambiente interno, o `rfdiag` automaticamente utiliza as fontes 2 (Torre Celular / TA) e 3 (GeoIP regional) como contingência.

---

## 6. Servidor de Telemetria & Painel Web Customizado

### 6.1. Arquitetura do Monitoramento
* **Agente no Celular**: `monitor_ping.sh` (executa pings nos alvos a cada 1 minuto + extrai RSRP, RSRQ, Timing Advance, bateria e faz push HTTP JSON).
* **Túnel ADB Reverso**: Redireciona o tráfego do celular (`localhost:8000`) diretamente para o Windows (`localhost:8000`) via USB.
* **Hub FastAPI (Local)**: Armazena as amostragens em SQLite WAL (`server/telemetry.db`) e expõe endpoints REST.
* **Painel Customizado**: Interface Web em HTML5, CSS moderno e Chart.js com atualização automática em tempo real a cada 3s.

### 6.2. Como Executar Localmente

1. **Garantir os túneis ADB ativos**:
   ```powershell
   & "C:\Users\ferrba\Documents\scrcpy-win64-v3.3.1\scrcpy-win64-v3.3.1\adb.exe" forward tcp:8022 tcp:8022
   & "C:\Users\ferrba\Documents\scrcpy-win64-v3.3.1\scrcpy-win64-v3.3.1\adb.exe" reverse tcp:8000 tcp:8000
   ```

2. **Iniciar o Servidor Web no Windows**:
   * Dê duplo clique em `server\start_server.bat`, ou no terminal:
   ```powershell
   cd C:\Users\ferrba\.gemini\antigravity\scratch\celldiag-telemetry\server
   python -m uvicorn main:app --host 0.0.0.0 --port 8000
   ```

3. **Abrir a Interface no Navegador**:
   Acesse: **`http://localhost:8000`**

4. **Iniciar o Agente de Telemetria no Celular**:
   * No Tabby / Termux:
   ```bash
   monitor_ping.sh
   ```
   * Ou para rodar em segundo plano:
   ```bash
   nohup monitor_ping.sh > ~/monitor/telemetry.log 2>&1 &
   ```

### 6.3. Detecção e Auditoria de Múltiplos IPs Públicos (Dual Egress)
Em chips IoT / M2M com múltiplos gateways de saída (ex: APN com redundância ou 2 IPs públicos de saída):
* O script do celular extrai o **IP Móvel da interface (`rmnet0`)** e consulta o **IP Público Real de Saída**.
* O backend compara automaticamente o IP público recebido com o anterior: se houver qualquer alteração de gateway (ex: saída A para saída B), é disparado o evento `TROCA_GATEWAY_PUBLICO` gravado na tabela `route_events`.
* No painel web, a linha correspondente é destacada com o badge `ROTA ALTERNADA`.

### 6.4. Migração para o Servidor AWS
Para migrar da validação local para a máquina da AWS:
1. Copie a pasta `server/` para a máquina AWS.
2. Inicie o FastAPI na AWS (`uvicorn main:app --host 0.0.0.0 --port 8000`).
3. No script do celular `monitor_ping.sh`, altere apenas a linha:
   `SERVER_URL="http://localhost:8000/api/telemetry"`
   para:
   `SERVER_URL="http://<IP_PUBLICO_AWS>:8000/api/telemetry"`
