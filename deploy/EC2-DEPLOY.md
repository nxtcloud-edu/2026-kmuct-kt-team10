# AWS EC2 배포 가이드

협업 회의 플랫폼(Node.js + Express + WebSocket)을 AWS EC2에 배포하는 절차입니다.

---

## 0. 준비물
- AWS 계정
- (선택) 도메인 이름
- 로컬에 이 저장소 코드

---

## 1. EC2 인스턴스 생성
1. AWS 콘솔 → EC2 → **인스턴스 시작**
2. **이름**: `collab-meeting`
3. **AMI**: Amazon Linux 2023 (또는 Ubuntu 22.04)
4. **인스턴스 유형**: `t3.micro` (프리티어) — 데모용으로 충분
5. **키 페어**: 새로 생성해서 `.pem` 파일 다운로드 (SSH 접속용, 잘 보관)
6. **네트워크 설정 → 보안 그룹**에서 인바운드 규칙 추가:
   - SSH (22) — 내 IP에서만 (권장)
   - HTTP (80) — Anywhere (0.0.0.0/0)
   - (nginx 안 쓰고 3000 직접 열 거면) 사용자지정 TCP 3000 — Anywhere
7. 인스턴스 시작 → **퍼블릭 IPv4 주소** 확인

---

## 2. SSH 접속
```bash
# .pem 권한 설정 (최초 1회, Linux/Mac)
chmod 400 collab-meeting.pem

# 접속 (Amazon Linux는 ec2-user, Ubuntu는 ubuntu)
ssh -i collab-meeting.pem ec2-user@<퍼블릭_IP>
```
Windows(PowerShell)에서도 동일하게 `ssh -i` 사용 가능.

---

## 3. Node.js 설치 (EC2 안에서)
### Amazon Linux 2023
```bash
sudo dnf update -y
# Node 20 설치 (NodeSource)
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs git
node --version   # v20.x 확인
```
### Ubuntu 22.04
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
```

---

## 4. 코드 올리기
### 방법 A) GitHub에서 clone (이 저장소가 public이거나 배포키 설정 시)
```bash
cd ~
git clone https://github.com/nxtcloud-edu/2026-kmuct-kt-team10.git
cd 2026-kmuct-kt-team10
```
### 방법 B) 로컬에서 scp로 업로드
```bash
# (로컬 PC에서 실행) node_modules/.git 제외하고 업로드하는 게 좋음
scp -i collab-meeting.pem -r ./2026-kmuct-kt-team10 ec2-user@<퍼블릭_IP>:~/
```

---

## 5. 의존성 설치 + 환경설정
```bash
cd ~/2026-kmuct-kt-team10
npm install --omit=dev

# .env 생성 (LLM 안 쓰면 키는 비워도 규칙기반으로 동작)
cat > .env <<'EOF'
PORT=3000
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
EOF
```

### 빠른 동작 확인
```bash
npm start
# 다른 터미널/브라우저에서 http://<퍼블릭_IP>:3000 접속 테스트
# (3000 포트를 보안그룹에서 열어둔 경우)
# 확인 후 Ctrl+C 로 종료
```

---

## 6. 상시 실행 설정 (systemd)
서버가 부팅 시 자동 시작되고, 죽으면 자동 재시작되도록 등록합니다.
```bash
# node 절대경로 확인 후 서비스 파일의 ExecStart와 맞추세요
which node        # 예: /usr/bin/node

sudo cp deploy/collab-meeting.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now collab-meeting
sudo systemctl status collab-meeting        # active (running) 확인
sudo journalctl -u collab-meeting -f        # 로그 실시간
```

---

## 7. 80 포트로 서비스 (nginx 리버스 프록시) — 권장
사용자가 `:3000` 없이 접속하고, 나중에 HTTPS도 붙이기 쉽습니다.
```bash
# Amazon Linux
sudo dnf install -y nginx
# Ubuntu: sudo apt install -y nginx

sudo cp deploy/nginx-collab-meeting.conf /etc/nginx/conf.d/collab-meeting.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl restart nginx
```
이제 `http://<퍼블릭_IP>` (포트 없이) 접속 → nginx가 3000으로 프록시.
보안그룹에서 3000은 닫고 80만 열어도 됩니다.

---

## 8. (선택) 도메인 + HTTPS
1. 도메인의 A 레코드를 EC2 퍼블릭 IP로 연결
2. nginx conf의 `server_name _;` 를 도메인으로 변경 후 `sudo systemctl restart nginx`
3. Let's Encrypt로 무료 인증서:
```bash
# Amazon Linux
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d meet.example.com
```

---

## 9. 업데이트 방법 (코드 변경 후 재배포)
```bash
cd ~/2026-kmuct-kt-team10
git pull                      # 또는 scp로 다시 업로드
npm install --omit=dev
sudo systemctl restart collab-meeting
```

---

## 주의사항
- **데이터 보존**: 현재 데이터는 `data/db.json` 파일에 저장됩니다. EC2를 종료/교체하면 사라지므로, 운영에서는 DynamoDB/RDS 같은 외부 DB로 옮기는 것을 권장합니다.
- **비밀정보**: `.env`는 절대 git에 올리지 마세요(이미 `.gitignore`에 포함). 키가 노출되면 즉시 폐기/재발급.
- **비용**: 프리티어 t3.micro 무료 한도를 넘으면 과금됩니다. 사용하지 않을 때 인스턴스 중지 권장.
- **포트 80 직접 사용**: nginx 없이 Node가 80을 직접 쓰려면 root 권한 또는 `sudo setcap 'cap_net_bind_service=+ep' $(which node)` 필요. nginx 방식을 권장합니다.
