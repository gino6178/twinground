"""Post-hoc reliability audit of the frozen research classifier, not deployment."""
from pathlib import Path
import json,hashlib,datetime,html
import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import softmax
from PIL import Image
import torch
from train_redesign_domars import SurfaceEncoder,evaluate,DATA,ROOT

OUT=DATA/'reliability_v1'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def scaled(p,t):return softmax(np.log(np.clip(p,1e-12,1))/t,axis=1)
def scores(p,y):
    confidence=p.max(1);correct=p.argmax(1)==y
    bins=[];ece=0.
    for i in range(15):
        mask=np.minimum((confidence*15).astype(int),14)==i
        if mask.any():
            acc=float(correct[mask].mean());conf=float(confidence[mask].mean())
            ece+=mask.mean()*abs(acc-conf)
            bins.append({'lower':i/15,'upper':(i+1)/15,'n':int(mask.sum()),'accuracy':acc,'confidence':conf})
    return {'n':len(y),'accuracy':float(correct.mean()),'nll':float(-np.log(np.clip(p[np.arange(len(y)),y],1e-12,1)).mean()),'brier':float(np.mean(np.sum((p-np.eye(p.shape[1])[y])**2,axis=1))),'ece_15_equal_width':float(ece),'bins':bins}
def selective(p,y,threshold):
    keep=p.max(1)>=threshold;n=int(keep.sum());errors=int(np.sum(p.argmax(1)[keep]!=y[keep]))
    upper=None
    if n:
        rate=errors/n;z=1.959963984540054
        upper=(rate+z*z/(2*n)+z*np.sqrt(rate*(1-rate)/n+z*z/(4*n*n)))/(1+z*z/n)
    return {'threshold':float(threshold),'accepted':n,'coverage':n/len(y),'errors':errors,'error_rate':errors/n if n else None,'wilson95_upper_error':upper}
def main():
    if OUT.exists():raise RuntimeError('Refusing to overwrite reliability_v1; inspect prior run')
    OUT.mkdir()
    checkpoint=DATA/'run_v1/best.pt';predfile=DATA/'run_v1/test_predictions.npz'
    protocol=json.loads((DATA/'frozen_protocol.json').read_text())
    audit={'created_at':now(),'model_sha256':sha(checkpoint),'dataset_protocol_sha256':sha(DATA/'frozen_protocol.json'),'script_sha256':sha(Path(__file__)),
      'temperature':'Fit scalar T in [0.05,20] by validation NLL; log probabilities floored at1e-12.',
      'threshold_grid':[.5,.55,.6,.65,.7,.75,.8,.85,.9,.95,.975,.99],
      'selection':'Maximum validation coverage with >=100 accepted and Wilson95 upper error <=0.15; if none, reject all with threshold1.000001.',
      'test_policy':'Existing consumed test split is a post-hoc audit, not a newly untouched holdout. Never tune on this audit.',
      'validation_limitation':'Same validation sources previously selected the checkpoint; calibration validation metrics are not independent generalization estimates.',
      'stress':'32each zeros/constant0.5/ones;64seeded uniform noise. Synthetic corrupt inputs are not real OOD classes.',
      'deployment':'Research only; no production ranking/classification changes.'}
    (OUT/'protocol.json').write_text(json.dumps(audit,indent=2)+'\n')
    torch.set_num_threads(4)
    if not torch.cuda.is_available():raise RuntimeError('Requires server CUDA')
    model=SurfaceEncoder().cuda();ck=torch.load(checkpoint,map_location='cpu',weights_only=False)
    assert ck['protocol_sha256']==audit['dataset_protocol_sha256']
    model.load_state_dict(ck['state_dict'])
    rows=[r for r in protocol['rows'] if r['split']=='validation'];images=[]
    for r in rows:
        path=DATA/r['path'];assert sha(path)==r['sha256']
        with Image.open(path) as im:images.append(np.asarray(im.convert('L').resize((128,128),Image.Resampling.BILINEAR)))
    y=np.array([protocol['labels'].index(r['label']) for r in rows])
    probabilities=evaluate(model,torch.from_numpy(np.stack(images)[:,None]),'cuda')
    np.savez_compressed(OUT/'validation_predictions.npz',truth=y,probabilities=probabilities,groups=[r['group'] for r in rows])
    def objective(logt):return scores(scaled(probabilities,np.exp(logt)),y)['nll']
    fit=minimize_scalar(objective,bounds=(np.log(.05),np.log(20)),method='bounded',options={'xatol':1e-8})
    assert fit.success
    temperature=float(np.exp(fit.x));calibrated=scaled(probabilities,temperature)
    options=[selective(calibrated,y,t) for t in audit['threshold_grid']]
    eligible=[v for v in options if v['accepted']>=100 and v['wilson95_upper_error']<=.15]
    chosen=max(eligible,key=lambda v:v['coverage'])['threshold'] if eligible else 1.000001
    sealed={'sealed_at':now(),'temperature':temperature,'threshold':chosen,'validation_choices':options,'validation_prediction_sha256':sha(OUT/'validation_predictions.npz'),'protocol_sha256':sha(OUT/'protocol.json')}
    (OUT/'sealed_calibration.json').write_text(json.dumps(sealed,indent=2)+'\n')
    print('Validation calibration sealed',temperature,chosen,flush=True)
    (OUT/'test_access.json').write_text(json.dumps({'access_at':now(),'source':str(predfile.relative_to(ROOT)),'source_sha256':sha(predfile),'sealed_sha256':sha(OUT/'sealed_calibration.json'),'already_used_test':True},indent=2)+'\n')
    with np.load(predfile) as d:tp=d['probabilities'];ty=d['truth'];groups=d['groups']
    cp=scaled(tp,temperature)
    assert np.array_equal(tp.argmax(1),cp.argmax(1))
    accepted=cp.max(1)>=chosen
    per_class=[{'class':label,'n':int(np.sum(ty==i)),'accepted':int(np.sum((ty==i)&accepted)),'correct_accepted':int(np.sum((ty==i)&accepted&(cp.argmax(1)==ty)))} for i,label in enumerate(protocol['labels'])]
    rng=np.random.default_rng(20261012);stress={}
    inputs={'zeros':np.zeros((32,1,128,128),dtype='uint8'),'constant':np.full((32,1,128,128),128,dtype='uint8'),'ones':np.full((32,1,128,128),255,dtype='uint8'),'uniform_noise':rng.integers(0,256,(64,1,128,128),dtype='uint8')}
    for name,x in inputs.items():
        p=scaled(evaluate(model,torch.from_numpy(x),'cuda'),temperature)
        stress[name]={'n':len(x),'mean_confidence':float(p.max(1).mean()),'max_confidence':float(p.max(1).max()),'accepted':int(np.sum(p.max(1)>=chosen)),'predicted_class_counts':dict(zip(protocol['labels'],np.bincount(p.argmax(1),minlength=15).tolist()))}
    group_report=[dict(group=str(g),**selective(cp[groups==g],ty[groups==g],chosen)) for g in np.unique(groups)]
    report={'created_at':now(),'scope':audit,'calibration':sealed,'validation':{'raw':scores(probabilities,y),'calibrated':scores(calibrated,y)},'test':{'raw':scores(tp,ty),'calibrated':scores(cp,ty),'selected':selective(cp,ty,chosen),'by_group':group_report,'by_class':per_class},'synthetic_stress':stress,'production_deployed':False}
    (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'T':temperature,'threshold':chosen,'test_raw_nll':report['test']['raw']['nll'],'test_calibrated_nll':report['test']['calibrated']['nll'],'test_selected':report['test']['selected'],'stress':{k:v['accepted'] for k,v in stress.items()}}),flush=True)
if __name__=='__main__':main()
