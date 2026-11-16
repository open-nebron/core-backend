#!/bin/sh
set -e

echo "[MinIO-Init] Configuring mc alias for MinIO..."
until (/usr/bin/mc alias set local http://minio:9000 minioadmin minioadmin); do
  echo "[MinIO-Init] MinIO is not ready yet, retrying in 1s..."
  sleep 1
done

echo "[MinIO-Init] Creating bucket 'zenuxs-media'..."
/usr/bin/mc mb --ignore-existing local/zenuxs-media

echo "[MinIO-Init] Setting public download policy on 'zenuxs-media/users'..."
/usr/bin/mc anonymous set download local/zenuxs-media/users

echo "[MinIO-Init] Bucket 'zenuxs-media' initialized successfully."
