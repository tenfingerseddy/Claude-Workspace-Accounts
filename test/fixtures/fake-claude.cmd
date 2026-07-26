@echo off
if /I "%~1 %~2"=="auth status" goto auth_status
if /I "%~1"=="--echo-stdin" goto echo_stdin
echo FAKE_CLAUDE_LAUNCHED %*
exit /b 0

:auth_status
echo {"loggedIn":true,"email":"%FAKE_EMAIL%","account":{"id":"%FAKE_ACCOUNT_ID%"},"organization":{"id":"org-work"}}
exit /b 0

:echo_stdin
echo FAKE_CLAUDE_LAUNCHED
more
exit /b 0
