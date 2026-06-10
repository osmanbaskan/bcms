@echo off
rem ============================================================
rem  BCMS Internal Root CA - Windows tek-tik kurulum (beINport)
rem  SAG TIK -> "Yonetici olarak calistir" ile baslatin.
rem  Sertifikayi "Guvenilen Kok Sertifika Yetkilileri" (Yerel
rem  Makine) deposuna kurar. Ozel anahtar ICERMEZ, sadece public
rem  kok sertifikadir.
rem ============================================================

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo [HATA] Bu dosyayi YONETICI olarak calistirmalisiniz:
  echo        sag tik ^> "Yonetici olarak calistir"
  pause
  exit /b 1
)

echo BCMS Internal Root CA kuruluyor...
certutil -addstore -f Root "%~dp0bcms-root-ca.cer"
if %errorLevel% neq 0 (
  echo [HATA] Kurulum basarisiz oldu.
  pause
  exit /b 1
)

certutil -verifystore Root "BCMS Internal Root CA" >nul 2>&1
if %errorLevel% equ 0 (
  echo.
  echo [OK] "BCMS Internal Root CA" guvenilen kok deposuna kuruldu.
) else (
  echo [UYARI] Dogrulama komutu sertifikayi listeleyemedi; elle kontrol edin.
)

echo.
echo ONEMLI: Chrome'u TAMAMEN kapatip yeniden acin
echo         (adres cubuguna chrome://restart yazmaniz yeterli).
echo Sonra https://beinport adresini acin - kilit simgesi gorunmeli.
echo.
pause
