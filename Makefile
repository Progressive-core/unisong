.PHONY: install proto core gateway all clean

# Install dependencies
install:
	pip install -r requirements.txt

# Generate gRPC code from proto
proto:
	python -m grpc_tools.protoc \
		-I./proto \
		--python_out=./core \
		--grpc_python_out=./core \
		./proto/unisong.proto

# Run gRPC Core Service
core:
	python -m core.server

# Run FastAPI Gateway
gateway:
	uvicorn gateway.main:app --host 0.0.0.0 --port 8000 --reload

# Run both services (in separate terminals)
all:
	@echo "Run in separate terminals:"
	@echo "  make core     # Terminal 1: gRPC Core Service (port 50051)"
	@echo "  make gateway  # Terminal 2: FastAPI Gateway (port 8000)"
	@echo ""
	@echo "Then open browser:"
	@echo "  http://localhost:8000/?role=master"
	@echo "  http://localhost:8000/?role=slave"

# Clean generated files
clean:
	rm -f core/unisong_pb2.py core/unisong_pb2_grpc.py
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
