@echo off
rem Stops the Agente server. Works from this PC or over SSH (Termius).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
