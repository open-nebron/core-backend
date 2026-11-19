#!/bin/sh
set -e

echo "[MinIO-Init] Configuring mc alias for MinIO..."
until (/usr/bin/mc alias set local http://minio:9000 minioadmin minioadmin); do
  echo "[MinIO-Init] MinIO is not ready yet, retrying in 1s..."
  sleep 1
done

echo "[MinIO-Init] Creating bucket 'nebron-media'..."
/usr/bin/mc mb --ignore-existing local/nebron-media

echo "[MinIO-Init] Setting public download policy on 'nebron-media/users'..."
/usr/bin/mc anonymous set download local/nebron-media/users

echo "[MinIO-Init] Bucket 'nebron-media' initialized successfully."
