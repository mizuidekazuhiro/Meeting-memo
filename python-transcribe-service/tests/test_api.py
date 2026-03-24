import os

from fastapi.testclient import TestClient


def test_health_endpoint():
    from main import app

    client = TestClient(app)
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json() == {'ok': True}


def test_auth_guard_rejects_invalid_token(monkeypatch):
    monkeypatch.setenv('API_TOKEN', 'expected-token')
    import importlib
    import config
    import auth

    importlib.reload(config)
    importlib.reload(auth)

    from fastapi import FastAPI, Depends

    app = FastAPI()

    @app.post('/guarded', dependencies=[Depends(auth.require_bearer_token)])
    def guarded():
        return {'ok': True}

    client = TestClient(app)
    response = client.post('/guarded', headers={'authorization': 'Bearer wrong'})
    assert response.status_code == 401

    monkeypatch.delenv('API_TOKEN', raising=False)
