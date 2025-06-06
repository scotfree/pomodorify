rm -rf lambda_package deployment.zip
mkdir lambda_package
python3 -m venv lambda_package/venv
source lambda_package/venv/bin/activate
pip install -r requirements.txt
cp -r lambda_package/venv/lib/python3.10/site-packages/* lambda_package/
deactivate
cp -r backend/* lambda_package/
cp -r frontend lambda_package/
cd lambda_package
zip -r ../deployment.zip .
cd ..
